// The DER encoding of the private listener's self-made certificate.
//
// The platform crypto API makes keys and reads certificates but cannot write
// one, so this file encodes the single certificate shape the listener needs
// and nothing more: an ECDSA P-256 key, signed by itself with SHA-256, a
// random 128-bit serial, not a certificate authority, for TLS server
// authentication, naming exactly one address or DNS name. Every other X.509
// feature is deliberately absent. Tests read the result back with the
// platform's X.509 reader and complete a real TLS handshake against it.

import { randomBytes, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

export interface ListenerCertificateFields {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** The listener's address or DNS name, without IPv6 brackets. */
  readonly hostname: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXTENDED_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const COMMON_NAME = "Octant private listener";

/** Encodes and signs the listener certificate, returning its DER bytes. */
export function encodeListenerCertificate(fields: ListenerCertificateFields): Buffer {
  if (
    fields.privateKey.asymmetricKeyType !== "ec" ||
    fields.privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("The listener certificate key must be ECDSA P-256.");
  }
  if (fields.notAfter.getTime() <= fields.notBefore.getTime()) {
    throw new Error("The listener certificate must end after it starts.");
  }
  const signatureAlgorithm = sequence(objectIdentifier(OID_ECDSA_WITH_SHA256));
  // Issuer and subject are the same name: the certificate signs itself.
  const name = sequence(set(sequence(objectIdentifier(OID_COMMON_NAME), utf8String(COMMON_NAME))));
  const tbsCertificate = sequence(
    contextExplicit(0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    signatureAlgorithm,
    name,
    sequence(time(fields.notBefore), time(fields.notAfter)),
    name,
    fields.publicKey.export({ format: "der", type: "spki" }),
    contextExplicit(
      3,
      sequence(
        // cA defaults to FALSE, and DER leaves a default value out, so an empty
        // sequence is "not a certificate authority".
        extension(OID_BASIC_CONSTRAINTS, true, sequence()),
        extension(OID_EXTENDED_KEY_USAGE, false, sequence(objectIdentifier(OID_SERVER_AUTH))),
        extension(OID_SUBJECT_ALT_NAME, false, sequence(subjectAltName(fields.hostname))),
      ),
    ),
  );
  // Node's default ECDSA output is the DER Ecdsa-Sig-Value X.509 expects.
  const signature = sign("sha256", tbsCertificate, fields.privateKey);
  return sequence(tbsCertificate, signatureAlgorithm, bitString(signature));
}

/** Wraps DER certificate bytes as a PEM block. */
export function certificatePem(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function serialNumber(): Buffer {
  // A serial must be positive and non-zero; the integer encoding adds the
  // leading zero byte that keeps a high first bit positive.
  for (;;) {
    const serial = randomBytes(16);
    if (serial.some((byte) => byte !== 0)) return serial;
  }
}

function subjectAltName(hostname: string): Buffer {
  const family = isIP(hostname);
  if (family === 4) return tagged(0x87, ipv4Bytes(hostname));
  if (family === 6) return tagged(0x87, ipv6Bytes(hostname));
  const name = hostname.toLowerCase();
  if (name.length === 0 || name.length > 253 || !/^[a-z0-9.-]+$/.test(name)) {
    throw new Error("The listener certificate needs an address or an ASCII DNS name.");
  }
  return tagged(0x82, Buffer.from(name, "ascii"));
}

function ipv4Bytes(address: string): Buffer {
  return Buffer.from(address.split(".").map(Number));
}

function ipv6Bytes(address: string): Buffer {
  // `isIP` has already accepted the text, so only the expansion is left: an
  // embedded IPv4 tail becomes two groups and `::` fills the missing zeros.
  let text = address;
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const v4 = ipv4Bytes(tail);
    text = `${text.slice(0, text.length - tail.length)}${v4.readUInt16BE(0).toString(16)}:${v4.readUInt16BE(2).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const leading = head === "" ? [] : head.split(":");
  const trailing = rest === undefined || rest === "" ? [] : rest.split(":");
  const groups =
    rest === undefined
      ? leading
      : [...leading, ...Array<string>(8 - leading.length - trailing.length).fill("0"), ...trailing];
  if (groups.length !== 8) throw new Error("The listener address is not a valid IPv6 address.");
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    objectIdentifier(oid),
    ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []),
    tagged(0x04, value),
  );
}

function time(date: Date): Buffer {
  const year = date.getUTCFullYear();
  const digits = [
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  if (year >= 1950 && year < 2050) {
    return tagged(0x17, Buffer.from(`${String(year % 100).padStart(2, "0")}${digits}Z`, "ascii"));
  }
  return tagged(0x18, Buffer.from(`${String(year).padStart(4, "0")}${digits}Z`, "ascii"));
}

function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >>> 7; value > 0; value >>>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tagged(0x06, Buffer.from(bytes));
}

function integer(unsigned: Buffer): Buffer {
  let start = 0;
  while (start < unsigned.length - 1 && unsigned[start] === 0) start += 1;
  const minimal = unsigned.subarray(start);
  const first = minimal[0] ?? 0;
  return tagged(0x02, first & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}

function utf8String(value: string): Buffer {
  return tagged(0x0c, Buffer.from(value, "utf8"));
}

function bitString(value: Buffer): Buffer {
  return tagged(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function sequence(...items: ReadonlyArray<Buffer>): Buffer {
  return tagged(0x30, Buffer.concat(items));
}

function set(...items: ReadonlyArray<Buffer>): Buffer {
  return tagged(0x31, Buffer.concat(items));
}

function contextExplicit(tagNumber: number, value: Buffer): Buffer {
  return tagged(0xa0 | tagNumber, value);
}

function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  const bytes: number[] = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
