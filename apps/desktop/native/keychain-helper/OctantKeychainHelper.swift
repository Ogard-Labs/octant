import Foundation
import Security
import CryptoKit
import LocalAuthentication

private let protocolVersion = 1
private let maximumMessageBytes = 16 * 1_024
private let providerService = "app.octant.provider-credentials"
private let hostIdentityService = "app.octant.host-identity.v1"
private let hostIdentityNamespace = "app.octant.host-identity.v1"
private let hostIdentityKeyId = "host-identity"
private let maximumPurgeProviderInstances = 128
private let uuidPattern = try! NSRegularExpression(
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
private let storeScopePattern = try! NSRegularExpression(
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
private let keyFingerprintPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")

private let nonInteractiveAuthenticationContext: LAContext = {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
}()

private enum StableError: String, Error {
    case missing
    case unavailable
    case failed
    case locked
}

// Every Octant-owned Keychain service. Every item also carries an opaque
// host-derived store scope in `kSecAttrGeneric`; a purge matches that exact
// scope as well as these service strings, so a selected local store can never
// enumerate or delete credentials belonging to another store.
private let octantOwnedServices = [providerService, hostIdentityService]

private struct OwnedCredential {
    let service: String
    let account: String
}

// Before store scoping was introduced, Octant wrote provider credentials
// without kSecAttrGeneric.  Retain the persistent reference for those legacy
// items so the migration can update exactly the unscoped record; a query that
// merely omits kSecAttrGeneric would also match newly scoped records.
private struct LegacyOwnedCredential {
    let service: String
    let account: String
    let persistentReference: Data
}

private var input = FileHandle.standardInput.readData(ofLength: maximumMessageBytes + 1)

private func emit(_ response: [String: Any]) -> Never {
    input.resetBytes(in: 0..<input.count)
    var data = (try? JSONSerialization.data(withJSONObject: response)) ?? Data()
    if data.count <= maximumMessageBytes {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    data.resetBytes(in: 0..<data.count)
    exit(response["ok"] as? Bool == true ? EXIT_SUCCESS : EXIT_FAILURE)
}

private func fail(_ error: StableError) -> Never {
    emit(["version": protocolVersion, "ok": false, "error": error.rawValue])
}

private func mapStatus(_ status: OSStatus) -> StableError {
    switch status {
    case errSecItemNotFound:
        return .missing
    case errSecNotAvailable, errSecInteractionNotAllowed, errSecAuthFailed:
        return .unavailable
    default:
        return .failed
    }
}

// Distinguishes a locked/needs-interaction Keychain from a Keychain that is
// simply not available at all, so the purge boundary can hand back a typed
// recovery hint instead of one generic "unavailable" bucket.
private func mapPurgeStatus(_ status: OSStatus) -> StableError {
    switch status {
    case errSecInteractionNotAllowed, errSecAuthFailed:
        return .locked
    case errSecNotAvailable:
        return .unavailable
    default:
        return .failed
    }
}

/// Security.framework can report a successful metadata query for a locked
/// keychain while deferring the protected data access until an interactive
/// prompt. Purge is never allowed to prompt or treat that state as an empty
/// inventory, so preflight every keychain in the current search list.
private func requireUnlockedKeychainSearchList() throws {
    var keychain: SecKeychain?
    let copyStatus = SecKeychainCopyDefault(&keychain)
    guard copyStatus == errSecSuccess, let keychain else { throw mapPurgeStatus(copyStatus) }
    var status: UInt32 = 0
    let statusResult = SecKeychainGetStatus(keychain, &status)
    guard statusResult == errSecSuccess else { throw mapPurgeStatus(statusResult) }
    guard (status & UInt32(kSecUnlockStateStatus)) != 0 else { throw StableError.locked }
}

// Enumerates every Octant-owned Keychain item across both owned services.
// Throws (rather than partially returning) on the first enumeration failure
// so a locked/unavailable Keychain never yields a truncated candidate list
// that a caller could mistake for "nothing to delete".
private func enumerateOwnedCredentials(storeScope: String) throws -> [OwnedCredential] {
    var candidates: [OwnedCredential] = []
    for service in octantOwnedServices {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrGeneric as String: Data(storeScope.utf8),
            kSecUseAuthenticationContext as String: nonInteractiveAuthenticationContext,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { continue }
        guard status == errSecSuccess else { throw mapPurgeStatus(status) }
        guard let items = result as? [[String: Any]] else { continue }
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String else { continue }
            candidates.append(OwnedCredential(service: service, account: account))
        }
    }
    return candidates
}

// Enumerates only legacy records which have no store scope.  The helper fails
// closed if Keychain returns an item that cannot be identified by a persistent
// reference, rather than risking a broad service/account update or delete.
private func enumerateLegacyOwnedCredentials(
    services: [String],
    account: String? = nil
) throws -> [LegacyOwnedCredential] {
    var candidates: [LegacyOwnedCredential] = []
    for service in services {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
            kSecReturnPersistentRef as String: true,
            kSecUseAuthenticationContext as String: nonInteractiveAuthenticationContext,
        ]
        if let account {
            query[kSecAttrAccount as String] = account
        }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { continue }
        guard status == errSecSuccess else { throw mapPurgeStatus(status) }
        guard let items = result as? [[String: Any]] else { throw StableError.failed }
        for item in items {
            // Scoped items are deliberately excluded. An unexpected non-Data
            // generic attribute is left untouched rather than guessing which
            // store owns it.
            guard item[kSecAttrGeneric as String] == nil else { continue }
            guard let itemAccount = item[kSecAttrAccount as String] as? String,
                  let persistentReference = item[kSecValuePersistentRef as String] as? Data
            else {
                throw StableError.failed
            }
            candidates.append(
                LegacyOwnedCredential(
                    service: service,
                    account: itemAccount,
                    persistentReference: persistentReference
                )
            )
        }
    }
    return candidates
}

// Re-scopes an exact legacy item. The persistent reference keeps the migration
// confined to the old unscoped record even if a scoped record for the same
// service/account exists by the time the request runs.
private func migrateLegacyCredential(
    _ candidate: LegacyOwnedCredential,
    storeScope: String,
    targetAccount: String
) throws {
    let attributes: [String: Any] = [
        kSecAttrAccount as String: targetAccount,
        kSecAttrGeneric as String: Data(storeScope.utf8),
    ]
    let status = SecItemUpdate(
        [kSecValuePersistentRef as String: candidate.persistentReference] as CFDictionary,
        attributes as CFDictionary
    )
    if status == errSecDuplicateItem {
        // The scoped item won a race (or was written by a newer client). It is
        // now authoritative for this exact account, so discard only the
        // persistent legacy record instead of touching any other store.
        let existingStatus = SecItemCopyMatching(
            baseQuery(service: candidate.service, account: targetAccount, storeScope: storeScope)
                as CFDictionary,
            nil
        )
        guard existingStatus == errSecSuccess else { throw mapStatus(existingStatus) }
        let deleteStatus = SecItemDelete(
            [kSecValuePersistentRef as String: candidate.persistentReference] as CFDictionary
        )
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw mapStatus(deleteStatus)
        }
        return
    }
    guard status == errSecSuccess || status == errSecItemNotFound else {
        throw mapStatus(status)
    }
}

private func migrateLegacyCredentialIfPresent(
    service: String,
    account: String,
    storeScope: String,
    targetAccount: String
) throws -> Bool {
    let candidates = try enumerateLegacyOwnedCredentials(services: [service], account: account)
    guard candidates.count <= 1 else { throw StableError.failed }
    guard let candidate = candidates.first else { return false }
    try migrateLegacyCredential(candidate, storeScope: storeScope, targetAccount: targetAccount)
    return true
}

private func legacyProviderCredentials(providerInstanceIds: [String]) throws -> [LegacyOwnedCredential] {
    var candidates: [LegacyOwnedCredential] = []
    for providerInstanceId in providerInstanceIds {
        let matching = try enumerateLegacyOwnedCredentials(
            services: [providerService],
            account: providerInstanceId
        )
        guard matching.count <= 1 else { throw StableError.failed }
        candidates.append(contentsOf: matching)
    }
    return candidates
}

private func migrateLegacyProviderCredentials(
    providerInstanceIds: [String],
    storeScope: String
) throws {
    for providerInstanceId in providerInstanceIds {
        _ = try migrateLegacyCredentialIfPresent(
            service: providerService,
            account: providerInstanceId,
            storeScope: storeScope,
            targetAccount: providerCredentialAccount(
                providerInstanceId: providerInstanceId,
                storeScope: storeScope
            )
        )
    }
}

// Generic-password uniqueness is service/account based; kSecAttrGeneric is a
// query attribute only. Provider account names therefore include the opaque
// store scope, just as host identities do, so copied stores may safely retain
// a provider-instance UUID without colliding in the shared Keychain.
private func providerCredentialAccount(providerInstanceId: String, storeScope: String) -> String {
    "\(providerInstanceId):\(storeScope)"
}

// A short-lived version of the scoped protocol used the raw provider UUID as
// the account and placed scope only in kSecAttrGeneric. Migrate that exact
// scoped record before creating the namespaced account, never scanning another
// store's account or scope.
private func migrateScopedCredentialIfPresent(
    service: String,
    account: String,
    storeScope: String,
    targetAccount: String
) throws -> Bool {
    guard account != targetAccount else { return false }
    var query = baseQuery(service: service, account: account, storeScope: storeScope)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnAttributes as String] = true
    query[kSecReturnPersistentRef as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess,
          let item = result as? [String: Any],
          let persistentReference = item[kSecValuePersistentRef as String] as? Data
    else {
        throw mapStatus(status)
    }
    try migrateLegacyCredential(
        LegacyOwnedCredential(
            service: service,
            account: account,
            persistentReference: persistentReference
        ),
        storeScope: storeScope,
        targetAccount: targetAccount
    )
    return true
}

private func migrateScopedProviderCredentialIfPresent(
    providerInstanceId: String,
    storeScope: String
) throws {
    let targetAccount = providerCredentialAccount(
        providerInstanceId: providerInstanceId,
        storeScope: storeScope
    )
    _ = try migrateScopedCredentialIfPresent(
        service: providerService,
        account: providerInstanceId,
        storeScope: storeScope,
        targetAccount: targetAccount
    )
}

// Legacy provider credentials do not encode a data-directory owner. Keep the
// exact unscoped record in place for read fallback so copied pre-scope stores
// sharing a provider UUID retain access. A selected-store purge has explicit
// inventory authority and may migrate that record separately.
private func legacyProviderCredentialIfPresent(
    providerInstanceId: String
) throws -> LegacyOwnedCredential? {
    let candidates = try enumerateLegacyOwnedCredentials(
        services: [providerService],
        account: providerInstanceId
    )
    guard candidates.count <= 1 else { throw StableError.failed }
    return candidates.first
}

private func readLegacyCredentialData(_ candidate: LegacyOwnedCredential) throws -> Data {
    let query: [String: Any] = [
        kSecValuePersistentRef as String: candidate.persistentReference,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let credentialData = result as? Data else {
        throw mapStatus(status)
    }
    return credentialData
}

private func validKeyFingerprint(_ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return keyFingerprintPattern.firstMatch(in: value, range: range)?.range == range
}

private func fingerprintForLegacyCredential(_ candidate: LegacyOwnedCredential) throws -> String {
    var query: [String: Any] = [
        kSecValuePersistentRef as String: candidate.persistentReference,
        kSecReturnData as String: true,
    ]
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, var privateKey = result as? Data, privateKey.count == 32 else {
        throw mapPurgeStatus(status)
    }
    result = nil
    let resultFingerprint = fingerprint(forPublicKey: privateKey)
    privateKey.resetBytes(in: 0..<privateKey.count)
    return resultFingerprint
}

private func legacyHostIdentityCredentials(
    expectedFingerprint: String?
) throws -> [LegacyOwnedCredential] {
    let candidates = try enumerateLegacyOwnedCredentials(
        services: [hostIdentityService],
        account: hostIdentityKeyId
    )
    guard candidates.count <= 1 else { throw StableError.failed }
    guard let candidate = candidates.first else { return [] }
    // A legacy host private key has no store scope. Its public fingerprint from
    // the selected staged SQLite store is the only ownership evidence that can
    // safely authorize moving it into this purge scope.
    guard let expectedFingerprint,
          try fingerprintForLegacyCredential(candidate) == expectedFingerprint
    else {
        throw StableError.failed
    }
    return [candidate]
}

// The former host identity was a singleton service/account record. A complete
// local-data purge must not report success while that selected store's legacy
// private identity remains. Move the exact record to this removal scope first;
// if the scoped successor exists, the persistent-reference migration deletes
// only this legacy item. Ambiguous/invalid legacy records fail closed.
private func migrateLegacyHostIdentityCredential(
    storeScope: String,
    expectedFingerprint: String?
) throws {
    let candidates = try legacyHostIdentityCredentials(expectedFingerprint: expectedFingerprint)
    guard let candidate = candidates.first else { return }
    try migrateLegacyCredential(
        candidate,
        storeScope: storeScope,
        targetAccount: hostIdentityAccount(storeScope: storeScope)
    )
}

private func baseQuery(service: String, account: String, storeScope: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrGeneric as String: Data(storeScope.utf8),
    ]
}

private func validProviderInstanceId(_ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return uuidPattern.firstMatch(in: value, range: range)?.range == range
}

private func validStoreScope(_ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return storeScopePattern.firstMatch(in: value, range: range)?.range == range
}

private func validProviderInstanceIds(_ values: [String]) -> Bool {
    guard values.count <= maximumPurgeProviderInstances else { return false }
    let normalized = values.map { $0.lowercased() }
    return normalized.allSatisfy(validProviderInstanceId) && Set(normalized).count == normalized.count
}

// kSecAttrGeneric is queryable but is not part of a generic-password item's
// uniqueness key. The fixed legacy account would therefore collide when two
// data directories create host identities. New records namespace the account
// itself, while legacy `host-identity` records are migrated on the first
// authenticated use of the exact store identity.
private func hostIdentityAccount(storeScope: String) -> String {
    "\(hostIdentityKeyId):\(storeScope)"
}
private func fingerprint(forPublicKey data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}

private func randomPrivateKeyMaterial() -> Data {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else { fail(.unavailable) }
    return Data(bytes)
}

private func ensureHostIdentityKey(
    storeScope: String,
    expectedLegacyFingerprint: String? = nil
) -> (fingerprint: String, privateKey: Data) {
    let account = hostIdentityAccount(storeScope: storeScope)
    var query = baseQuery(service: hostIdentityService, account: account, storeScope: storeScope)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let privateKey = result as? Data, privateKey.count == 32 {
        // Public material fingerprint is derived from private material hash for stable identity
        // without exporting a private key. Private key never leaves this process response path.
        let fp = fingerprint(forPublicKey: privateKey)
        result = nil
        return (fp, privateKey)
    }
    if status != errSecItemNotFound {
        fail(mapStatus(status))
    }

    // A legacy host identity was a singleton. The persisted fingerprint from
    // this selected store is the only ownership evidence that authorizes
    // moving it into this scope; a second data directory must never claim it
    // simply because it happens to initialize first.
    do {
        try migrateLegacyHostIdentityCredential(
            storeScope: storeScope,
            expectedFingerprint: expectedLegacyFingerprint
        )
    } catch let error as StableError {
        fail(error)
    } catch {
        fail(.failed)
    }

    query = baseQuery(service: hostIdentityService, account: account, storeScope: storeScope)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    result = nil
    let migratedStatus = SecItemCopyMatching(query as CFDictionary, &result)
    if migratedStatus == errSecSuccess, let privateKey = result as? Data, privateKey.count == 32 {
        let fp = fingerprint(forPublicKey: privateKey)
        result = nil
        return (fp, privateKey)
    }
    if migratedStatus != errSecItemNotFound {
        fail(mapStatus(migratedStatus))
    }

    let privateKey = randomPrivateKeyMaterial()
    var addQuery = baseQuery(service: hostIdentityService, account: account, storeScope: storeScope)
    addQuery[kSecValueData as String] = privateKey
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    addQuery.removeValue(forKey: kSecValueData as String)
    guard addStatus == errSecSuccess else { fail(mapStatus(addStatus)) }
    let fp = fingerprint(forPublicKey: privateKey)
    return (fp, privateKey)
}

private func rotateHostIdentityKey(storeScope: String) -> String {
    _ = SecItemDelete(
        baseQuery(
            service: hostIdentityService,
            account: hostIdentityAccount(storeScope: storeScope),
            storeScope: storeScope
        ) as CFDictionary
    )
    return ensureHostIdentityKey(storeScope: storeScope).fingerprint
}

private func signHostPayload(_ payloadBase64: String, storeScope: String) -> (fingerprint: String, signature: String) {
    let ensured = ensureHostIdentityKey(storeScope: storeScope)
    guard let payload = Data(base64Encoded: payloadBase64), !payload.isEmpty else { fail(.failed) }
    // HMAC-SHA256 with host private material; response only returns signature + fingerprint.
    let key = SymmetricKey(data: ensured.privateKey)
    let signature = HMAC<SHA256>.authenticationCode(for: payload, using: key)
    let signatureData = Data(signature)
    return (ensured.fingerprint, signatureData.base64EncodedString())
}

guard input.count <= maximumMessageBytes,
      input.last == 0x0A,
      input.dropLast().firstIndex(of: 0x0A) == nil,
      let object = try? JSONSerialization.jsonObject(with: input),
      let request = object as? [String: Any],
      request["version"] as? Int == protocolVersion,
      let operation = request["operation"] as? String
else {
    fail(.failed)
}

// Host-identity namespace path
if let namespace = request["namespace"] as? String {
    guard namespace == hostIdentityNamespace,
          let keyId = request["keyId"] as? String,
          keyId == hostIdentityKeyId,
          let storeScope = request["storeScope"] as? String,
          validStoreScope(storeScope)
    else {
        fail(.failed)
    }

    switch operation {
    case "ensure":
        let ensureKeys: Set<String> = ["version", "namespace", "operation", "keyId", "storeScope"]
        guard Set(request.keys) == ensureKeys || Set(request.keys) == ensureKeys.union(["expectedFingerprint"])
        else { fail(.failed) }
        let expectedFingerprint: String?
        if request["expectedFingerprint"] == nil {
            expectedFingerprint = nil
        } else if let value = request["expectedFingerprint"] as? String, validKeyFingerprint(value) {
            expectedFingerprint = value
        } else {
            fail(.failed)
        }
        let ensured = ensureHostIdentityKey(
            storeScope: storeScope,
            expectedLegacyFingerprint: expectedFingerprint
        )
        emit([
            "version": protocolVersion,
            "ok": true,
            "operation": "ensure",
            "keyId": hostIdentityKeyId,
            "fingerprint": ensured.fingerprint,
        ])
    case "rotate":
        guard Set(request.keys) == Set(["version", "namespace", "operation", "keyId", "storeScope"]) else { fail(.failed) }
        let fp = rotateHostIdentityKey(storeScope: storeScope)
        emit([
            "version": protocolVersion,
            "ok": true,
            "operation": "rotate",
            "keyId": hostIdentityKeyId,
            "fingerprint": fp,
        ])
    case "sign":
        guard Set(request.keys) == Set(["version", "namespace", "operation", "keyId", "storeScope", "payload"]),
              let payload = request["payload"] as? String,
              !payload.isEmpty
        else {
            fail(.failed)
        }
        let signed = signHostPayload(payload, storeScope: storeScope)
        emit([
            "version": protocolVersion,
            "ok": true,
            "operation": "sign",
            "keyId": hostIdentityKeyId,
            "fingerprint": signed.fingerprint,
            "signature": signed.signature,
        ])
    default:
        fail(.failed)
    }
}

// Data-lifecycle purge path: enumerates and, unless dryRun, deletes only
// Keychain items attached to the selected opaque store scope. It never reports
// plaintext credential material or inspects another store's credentials.
if operation == "purge" {
    let purgeKeys: Set<String> = ["version", "operation", "dryRun", "storeScope", "providerInstanceIds"]
    guard (Set(request.keys) == purgeKeys || Set(request.keys) == purgeKeys.union(["hostIdentityFingerprint"])),
          let dryRun = request["dryRun"] as? Bool,
          let storeScope = request["storeScope"] as? String,
          validStoreScope(storeScope),
          let providerInstanceIds = request["providerInstanceIds"] as? [String],
          validProviderInstanceIds(providerInstanceIds)
    else {
        fail(.failed)
    }
    let hostIdentityFingerprint: String?
    if request["hostIdentityFingerprint"] is NSNull || request["hostIdentityFingerprint"] == nil {
        hostIdentityFingerprint = nil
    } else if let value = request["hostIdentityFingerprint"] as? String, validKeyFingerprint(value) {
        hostIdentityFingerprint = value
    } else {
        fail(.failed)
    }

    do {
        try requireUnlockedKeychainSearchList()
    } catch let error as StableError {
        fail(error)
    } catch {
        fail(.failed)
    }

    let candidates: [OwnedCredential]
    do {
        candidates = try enumerateOwnedCredentials(storeScope: storeScope)
    } catch let error as StableError {
        fail(error)
    } catch {
        fail(.failed)
    }

    if dryRun {
        // A preview must not claim or re-scope any legacy item. The server
        // supplies only provider identities referenced by the selected store,
        // so this count remains ownership-preserving even on a Mac that has
        // several pre-upgrade data directories.
        let legacyCandidates: [LegacyOwnedCredential]
        let legacyHostCandidates: [LegacyOwnedCredential]
        do {
            legacyCandidates = try legacyProviderCredentials(providerInstanceIds: providerInstanceIds)
            legacyHostCandidates = try legacyHostIdentityCredentials(
                expectedFingerprint: hostIdentityFingerprint
            )
        } catch let error as StableError {
            fail(error)
        } catch {
            fail(.failed)
        }
        emit([
            "version": protocolVersion,
            "ok": true,
            "operation": "purge",
            "dryRun": true,
            "matchedCount": candidates.count + legacyCandidates.count + legacyHostCandidates.count,
        ])
    }

    do {
        // A destructive purge may migrate only the provider identities that
        // the selected SQLite store supplied. Never enumerate or claim every
        // unscoped Keychain credential: another pre-upgrade store may own it.
        try migrateLegacyProviderCredentials(
            providerInstanceIds: providerInstanceIds,
            storeScope: storeScope
        )
        try migrateLegacyHostIdentityCredential(
            storeScope: storeScope,
            expectedFingerprint: hostIdentityFingerprint
        )
    } catch let error as StableError {
        fail(error)
    } catch {
        fail(.failed)
    }

    let migratedCandidates: [OwnedCredential]
    do {
        migratedCandidates = try enumerateOwnedCredentials(storeScope: storeScope)
    } catch let error as StableError {
        fail(error)
    } catch {
        fail(.failed)
    }

    var deletedCount = 0
    var failedCount = 0
    for candidate in migratedCandidates {
        let status = SecItemDelete(
            baseQuery(service: candidate.service, account: candidate.account, storeScope: storeScope) as CFDictionary
        )
        if status == errSecSuccess || status == errSecItemNotFound {
            deletedCount += 1
        } else {
            failedCount += 1
        }
    }
    emit([
        "version": protocolVersion,
        "ok": true,
        "operation": "purge",
        "dryRun": false,
        "deletedCount": deletedCount,
        "failedCount": failedCount,
    ])
}

// Provider-credentials path (existing)
guard let account = request["providerInstanceId"] as? String,
      validProviderInstanceId(account),
      let storeScope = request["storeScope"] as? String,
      validStoreScope(storeScope)
else {
    fail(.failed)
}
let providerAccount = providerCredentialAccount(providerInstanceId: account, storeScope: storeScope)

let commonKeys: Set<String> = ["version", "operation", "providerInstanceId", "storeScope"]
let allowedKeys = operation == "set" ? commonKeys.union(["credential"]) : commonKeys
guard Set(request.keys) == allowedKeys else {
    fail(.failed)
}

switch operation {
case "set":
    guard let credential = request["credential"] as? String,
          !credential.isEmpty,
          var credentialData = credential.data(using: .utf8)
    else {
        fail(.failed)
    }
    // A previous scoped/raw-account record belongs to this exact store and can
    // migrate. An unscoped record may belong to a copied store, so leave it as
    // a fallback while this selected store writes its independent credential.
    do {
        try migrateScopedProviderCredentialIfPresent(providerInstanceId: account, storeScope: storeScope)
    } catch let error as StableError {
        credentialData.resetBytes(in: 0..<credentialData.count)
        fail(error)
    } catch {
        credentialData.resetBytes(in: 0..<credentialData.count)
        fail(.failed)
    }

    var addQuery = baseQuery(service: providerService, account: providerAccount, storeScope: storeScope)
    addQuery[kSecValueData as String] = credentialData
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    let finalStatus: OSStatus
    if addStatus == errSecDuplicateItem {
        finalStatus = SecItemUpdate(
            baseQuery(service: providerService, account: providerAccount, storeScope: storeScope) as CFDictionary,
            [kSecValueData as String: credentialData] as CFDictionary
        )
    } else {
        finalStatus = addStatus
    }
    addQuery.removeValue(forKey: kSecValueData as String)
    credentialData.resetBytes(in: 0..<credentialData.count)
    guard finalStatus == errSecSuccess else { fail(mapStatus(finalStatus)) }
    emit(["version": protocolVersion, "ok": true])

case "has":
    var query = baseQuery(service: providerService, account: providerAccount, storeScope: storeScope)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecItemNotFound {
        do {
            try migrateScopedProviderCredentialIfPresent(providerInstanceId: account, storeScope: storeScope)
        } catch let error as StableError {
            fail(error)
        } catch {
            fail(.failed)
        }
        status = SecItemCopyMatching(query as CFDictionary, nil)
    }
    if status == errSecItemNotFound {
        do {
            if try legacyProviderCredentialIfPresent(providerInstanceId: account) != nil {
                emit(["version": protocolVersion, "ok": true, "present": true])
            }
        } catch let error as StableError {
            fail(error)
        } catch {
            fail(.failed)
        }
        emit(["version": protocolVersion, "ok": true, "present": false])
    }
    guard status == errSecSuccess else { fail(mapStatus(status)) }
    emit(["version": protocolVersion, "ok": true, "present": true])

case "resolve":
    var query = baseQuery(service: providerService, account: providerAccount, storeScope: storeScope)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    var status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        do {
            try migrateScopedProviderCredentialIfPresent(providerInstanceId: account, storeScope: storeScope)
        } catch let error as StableError {
            fail(error)
        } catch {
            fail(.failed)
        }
        result = nil
        status = SecItemCopyMatching(query as CFDictionary, &result)
    }
    if status == errSecItemNotFound {
        do {
            guard let legacy = try legacyProviderCredentialIfPresent(providerInstanceId: account) else {
                fail(.missing)
            }
            var credentialData = try readLegacyCredentialData(legacy)
            guard let credential = String(data: credentialData, encoding: .utf8) else {
                fail(.failed)
            }
            credentialData.resetBytes(in: 0..<credentialData.count)
            emit(["version": protocolVersion, "ok": true, "credential": credential])
        } catch let error as StableError {
            fail(error)
        } catch {
            fail(.failed)
        }
    }
    guard status == errSecSuccess else { fail(mapStatus(status)) }
    guard var credentialData = result as? Data,
          let credential = String(data: credentialData, encoding: .utf8)
    else {
        fail(.failed)
    }
    result = nil
    credentialData.resetBytes(in: 0..<credentialData.count)
    emit(["version": protocolVersion, "ok": true, "credential": credential])

case "delete":
    do {
        try migrateScopedProviderCredentialIfPresent(providerInstanceId: account, storeScope: storeScope)
    } catch let error as StableError {
        fail(error)
    } catch {
        fail(.failed)
    }
    let status = SecItemDelete(baseQuery(service: providerService, account: providerAccount, storeScope: storeScope) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail(mapStatus(status)) }
    emit(["version": protocolVersion, "ok": true])

default:
    fail(.failed)
}
