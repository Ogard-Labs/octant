import { useCallback, useEffect, useState } from "react";
import {
  Image,
  Platform,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type LayoutChangeEvent,
} from "react-native";
import { Asset } from "expo-asset";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { clampEffect, sourceKey, type GroundEffect, type Size } from "./groundPrint";

export interface PrintedGroundProps {
  readonly source: ImageSourcePropType;
  readonly effect: GroundEffect;
  readonly testID?: string;
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

/**
 * Mirrors `bayerThreshold` in groundPrint.ts. GLSL ES 1.0 has no bitwise
 * operators, so each bit is read with mod/floor and xor is (a + b) mod 2.
 * Rows count from the top, as the desktop's canvas does, so the dither
 * pattern and the cell grid sit on the same corner.
 */
const FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uPicture;
uniform vec2 uViewport;
uniform vec2 uPictureSize;
uniform float uCell;
uniform float uSteps;
float bit(float v, float b) { return mod(floor(v / b), 2.0); }
float bayer(vec2 p) {
  float x = mod(p.x, 8.0);
  float y = mod(p.y, 8.0);
  float v = mod(bit(x, 1.0) + bit(y, 1.0), 2.0) * 32.0 + bit(y, 1.0) * 16.0
          + mod(bit(x, 2.0) + bit(y, 2.0), 2.0) * 8.0 + bit(y, 2.0) * 4.0
          + mod(bit(x, 4.0) + bit(y, 4.0), 2.0) * 2.0 + bit(y, 4.0);
  return (v + 0.5) / 64.0;
}
void main() {
  vec2 top = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y);
  vec2 cell = floor(top / uCell);
  vec2 centre = (cell + 0.5) * uCell;
  float scale = max(uViewport.x / uPictureSize.x, uViewport.y / uPictureSize.y);
  vec2 pic = (centre - uViewport * 0.5) / scale + uPictureSize * 0.5;
  vec3 c = texture2D(uPicture, pic / uPictureSize).rgb;
  if (uSteps > 0.0) {
    float shift = (bayer(cell) - 0.5) / uSteps;
    c = floor(clamp(c + shift, 0.0, 1.0) * uSteps + 0.5) / uSteps;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

interface Renderer {
  readonly gl: ExpoWebGLRenderingContext;
  readonly program: WebGLProgram;
  readonly texture: WebGLTexture;
}

interface LoadedPicture {
  readonly size: Size;
}

function compile(gl: WebGLRenderingContext, type: number, code: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("Could not create a shader.");
  gl.shaderSource(shader, code);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Shader did not compile.");
  }
  return shader;
}

function createRenderer(gl: ExpoWebGLRenderingContext): Renderer {
  const program = gl.createProgram();
  const texture = gl.createTexture();
  const buffer = gl.createBuffer();
  if (program === null || texture === null || buffer === null) {
    throw new Error("Could not allocate GL objects.");
  }
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Program did not link.");
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  return { gl, program, texture };
}

function sourceAsset(source: ImageSourcePropType): Asset | undefined {
  if (typeof source === "number") return Asset.fromModule(source);
  if (!Array.isArray(source) && "uri" in source && typeof source.uri === "string") {
    return Asset.fromURI(source.uri);
  }
  return undefined;
}

function nativeImageSize(uri: string): Promise<Size> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

function loadWebImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture could not be decoded."));
    image.src = uri;
  });
}

/**
 * Uploads the picture into the renderer's texture and reports its pixel size,
 * or `undefined` when `isCurrent` turned false while it loaded. Every await
 * finishes before the shared texture is touched, so a request that was
 * replaced mid-download never writes its picture over the newer one.
 */
async function uploadPicture(
  renderer: Renderer,
  source: ImageSourcePropType,
  filter: number,
  isCurrent: () => boolean,
): Promise<LoadedPicture | undefined> {
  const asset = sourceAsset(source);
  if (asset === undefined) throw new Error("Unsupported picture source.");
  await asset.downloadAsync();
  const { gl, texture } = renderer;
  const uri = asset.localUri ?? asset.uri;
  const webImage = Platform.OS === "web" ? await loadWebImage(uri) : undefined;
  const size =
    webImage !== undefined
      ? { width: webImage.naturalWidth, height: webImage.naturalHeight }
      : asset.width !== null && asset.height !== null
        ? { width: asset.width, height: asset.height }
        : await nativeImageSize(uri);
  if (!isCurrent()) return undefined;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Non-power-of-two pictures need clamped edges and no mipmaps in GLES 2.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  if (webImage !== undefined) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, webImage);
    return { size };
  }
  // The native bridge reads a file-backed source that the DOM typings do not
  // describe, so the call goes through Reflect rather than a typed overload.
  Reflect.apply(gl.texImage2D, gl, [
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    { localUri: uri, ...size },
  ]);
  return { size };
}

function draw(
  renderer: Renderer,
  picture: LoadedPicture,
  effect: GroundEffect,
  layoutWidth: number,
): void {
  const { gl, program } = renderer;
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  // A cell is `cell` points, so it grows with the buffer's pixel ratio.
  const ratio = layoutWidth > 0 ? width / layoutWidth : 1;
  const printed = effect.kind !== "none";
  gl.viewport(0, 0, width, height);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "uPicture"), 0);
  gl.uniform2f(gl.getUniformLocation(program, "uViewport"), width, height);
  gl.uniform2f(
    gl.getUniformLocation(program, "uPictureSize"),
    picture.size.width,
    picture.size.height,
  );
  gl.uniform1f(gl.getUniformLocation(program, "uCell"), printed ? effect.cell * ratio : 1);
  gl.uniform1f(
    gl.getUniformLocation(program, "uSteps"),
    effect.kind === "dither" ? effect.levels - 1 : 0,
  );
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.endFrameEXP();
}

/**
 * The ground printed once through a fragment shader: the picture covers the
 * view, then is shown as it is, pixelated, or dithered like the desktop. It
 * redraws only when the picture, the effect or the size changes, never on a
 * loop, because nothing moves across the ground. If GL or the texture fails
 * the plain image shows instead.
 */
export function PrintedGround(props: PrintedGroundProps) {
  const effect = clampEffect(props.effect);
  const [renderer, setRenderer] = useState<Renderer | undefined>();
  const [layout, setLayout] = useState<Size>({ width: 0, height: 0 });
  // A GL context that cannot be used stays on the plain picture for good; a
  // picture that cannot be loaded is only that picture's problem.
  const [contextFailed, setContextFailed] = useState(false);
  const [pictureFailed, setPictureFailed] = useState(false);
  const [picture, setPicture] = useState<LoadedPicture | undefined>();
  const filter = effect.kind === "none" ? "linear" : "nearest";

  const failContext = useCallback((cause: unknown) => {
    if (__DEV__) console.warn("Printed ground fell back to the plain picture.", cause);
    setContextFailed(true);
  }, []);

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      try {
        setRenderer(createRenderer(gl));
      } catch (cause) {
        failContext(cause);
      }
    },
    [failContext],
  );

  // Reload the texture when the picture or its filtering changes; a stale
  // load that finishes late must not replace a newer one. The effect follows
  // the source's identity, not the object, so an inline `{ uri }` does not
  // reload on every render, and a new source gets a fresh try.
  const { source } = props;
  const pictureKey = sourceKey(source);
  useEffect(() => {
    if (renderer === undefined) return;
    let current = true;
    const { gl } = renderer;
    setPictureFailed(false);
    void uploadPicture(
      renderer,
      source,
      filter === "linear" ? gl.LINEAR : gl.NEAREST,
      () => current,
    ).then(
      (loaded) => {
        if (current && loaded !== undefined) setPicture(loaded);
      },
      (cause: unknown) => {
        if (!current) return;
        if (__DEV__) console.warn("Printed ground could not load its picture.", cause);
        setPictureFailed(true);
      },
    );
    return () => {
      current = false;
    };
    // `source` is read through `pictureKey`, which changes whenever it does.
  }, [renderer, pictureKey, filter]);

  const { kind, cell, levels } = effect;
  useEffect(() => {
    if (renderer === undefined || picture === undefined) return;
    try {
      draw(renderer, picture, { kind, cell, levels }, layout.width);
    } catch (cause) {
      failContext(cause);
    }
    // The buffer follows the view's height too, so a height-only change redraws.
  }, [renderer, picture, kind, cell, levels, layout.width, layout.height, failContext]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setLayout((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  };

  if (contextFailed) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        resizeMode="cover"
        source={props.source}
        style={StyleSheet.absoluteFill}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}-fallback` })}
      />
    );
  }
  return (
    <View
      onLayout={onLayout}
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      <GLView onContextCreate={onContextCreate} style={StyleSheet.absoluteFill} />
      {pictureFailed ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={source}
          style={StyleSheet.absoluteFill}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}-fallback` })}
        />
      ) : null}
    </View>
  );
}
