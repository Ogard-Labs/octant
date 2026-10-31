// X25519 (RFC 7748) with no library, because the platform offers it only from
// Android 13 and the phone's receiver must open sealed content on every
// supported release. Only the receiving side's two uses are here: a public
// key from a private one, and the shared point of a private key and a sender's
// public key. It is not constant time: it runs on the phone, on a key that
// never leaves it, against a sender who sees only whether a notification
// opened.

package sh.octant.push

import java.math.BigInteger

object X25519 {
  private val prime: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
  private val a24: BigInteger = BigInteger.valueOf(121_665)
  private val basePoint: ByteArray = ByteArray(32).also { it[0] = 9 }

  const val KEY_BYTES = 32

  fun publicKey(privateKey: ByteArray): ByteArray = scalarMultiply(privateKey, basePoint)

  fun scalarMultiply(scalar: ByteArray, point: ByteArray): ByteArray {
    require(scalar.size == KEY_BYTES && point.size == KEY_BYTES) { "X25519 keys are 32 bytes." }
    val clamped = scalar.copyOf()
    clamped[0] = (clamped[0].toInt() and 248).toByte()
    clamped[31] = ((clamped[31].toInt() and 127) or 64).toByte()
    val k = fromLittleEndian(clamped)
    val maskedPoint = point.copyOf()
    maskedPoint[31] = (maskedPoint[31].toInt() and 127).toByte()
    val x1 = fromLittleEndian(maskedPoint).mod(prime)

    var x2 = BigInteger.ONE
    var z2 = BigInteger.ZERO
    var x3 = x1
    var z3 = BigInteger.ONE
    var swap = false
    for (bit in 254 downTo 0) {
      val kBit = k.testBit(bit)
      if (swap != kBit) {
        val tx = x2
        x2 = x3
        x3 = tx
        val tz = z2
        z2 = z3
        z3 = tz
      }
      swap = kBit
      val a = x2.add(z2).mod(prime)
      val aa = a.multiply(a).mod(prime)
      val b = x2.subtract(z2).mod(prime)
      val bb = b.multiply(b).mod(prime)
      val e = aa.subtract(bb).mod(prime)
      val c = x3.add(z3).mod(prime)
      val d = x3.subtract(z3).mod(prime)
      val da = d.multiply(a).mod(prime)
      val cb = c.multiply(b).mod(prime)
      x3 = da.add(cb).mod(prime).pow(2).mod(prime)
      z3 = x1.multiply(da.subtract(cb).mod(prime).pow(2)).mod(prime)
      x2 = aa.multiply(bb).mod(prime)
      z2 = e.multiply(aa.add(a24.multiply(e)).mod(prime)).mod(prime)
    }
    if (swap) {
      val tx = x2
      x2 = x3
      x3 = tx
      val tz = z2
      z2 = z3
      z3 = tz
    }
    val result = x2.multiply(z2.modPow(prime.subtract(BigInteger.valueOf(2)), prime)).mod(prime)
    return toLittleEndian(result)
  }

  private fun fromLittleEndian(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

  private fun toLittleEndian(value: BigInteger): ByteArray {
    val big = value.toByteArray().reversedArray()
    val out = ByteArray(KEY_BYTES)
    for (index in 0 until minOf(big.size, KEY_BYTES)) out[index] = big[index]
    return out
  }
}
