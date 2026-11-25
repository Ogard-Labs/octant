/** Metro gives a picture as a source the Image component draws. */
declare module "*.png" {
  const source: import("react-native").ImageSourcePropType;
  export default source;
}
