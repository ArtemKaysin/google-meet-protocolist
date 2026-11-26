import Foundation
import LocalAuthentication
import Security

private let service = "com.github.ArtemKaysin.google-meet-protocolist.browser-session"
private let maxBytes = 256 * 1024

private func key(_ service: String, _ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: account,
     kSecAttrSynchronizable as String: false]
}

private func quiet(_ service: String, _ account: String) -> [String: Any] {
    let context = LAContext()
    context.interactionNotAllowed = true
    var query = key(service, account)
    query[kSecUseAuthenticationContext as String] = context
    return query
}

private func read(_ service: String, _ account: String) -> (OSStatus, Data?) {
    var query = quiet(service, account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    return (status, item as? Data)
}

private func save(_ service: String, _ account: String, _ data: Data, update: Bool) -> OSStatus {
    var attrs = key(service, account)
    attrs[kSecValueData as String] = data
    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status != errSecDuplicateItem || !update { return status }
    let change = [kSecValueData as String: data]
    return SecItemUpdate(quiet(service, account) as CFDictionary, change as CFDictionary)
}

private func fail(_ status: OSStatus? = nil) -> Never {
    let message = status.map { "Keychain request failed (\($0))." } ?? "Invalid Keychain request."
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

private func validAccount(_ account: String) -> Bool {
    account.utf8.count <= 254 && account == account.lowercased() &&
        account.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil &&
        account.rangeOfCharacter(from: .controlCharacters) == nil
}

private func readInput() throws -> Data {
    var data = Data()
    while data.count <= maxBytes {
        guard let chunk = try FileHandle.standardInput.read(upToCount: min(16 * 1024, maxBytes + 1 - data.count)),
              !chunk.isEmpty else { break }
        data.append(chunk)
    }
    return data
}

private func hasPrivateOutputPipe() -> Bool {
    var info = stat()
    guard fstat(STDOUT_FILENO, &info) == 0 else { return false }
    let type = info.st_mode & mode_t(S_IFMT)
    return type == mode_t(S_IFIFO) || type == mode_t(S_IFSOCK)
}

private func selfTest() -> Bool {
    let fixture = "\(service).fixture.\(UUID().uuidString)"
    let a = "first@example.invalid", b = "second@example.invalid"
    let first = Data("synthetic-first".utf8), second = Data("synthetic-second".utf8)
    let updated = Data("synthetic-updated".utf8)
    var created: [String] = []
    var ok = read(fixture, a).0 == errSecItemNotFound && read(fixture, b).0 == errSecItemNotFound
    if ok, save(fixture, a, first, update: false) == errSecSuccess { created.append(a) }
    if created.count == 1, save(fixture, b, second, update: false) == errSecSuccess { created.append(b) }
    ok = created.count == 2 && read(fixture, a).1 == first && read(fixture, b).1 == second &&
        save(fixture, a, updated, update: true) == errSecSuccess &&
        read(fixture, a).1 == updated && read(fixture, b).1 == second
    for account in created {
        let removed = SecItemDelete(quiet(fixture, account) as CFDictionary) == errSecSuccess
        ok = removed && read(fixture, account).0 == errSecItemNotFound && ok
    }
    return ok
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["self-test"] {
    guard selfTest() else { fail() }
    print("Keychain fixture: account isolation, update and cleanup verified")
    exit(0)
}
guard args.count == 2, validAccount(args[1]) else { fail() }
let account = args[1]
switch args[0] {
case "read":
    guard hasPrivateOutputPipe() else { fail() }
    let (status, data) = read(service, account)
    if status == errSecItemNotFound { exit(3) }
    guard status == errSecSuccess, let data, !data.isEmpty, data.count <= maxBytes else { fail(status) }
    FileHandle.standardOutput.write(data)
case "write":
    guard var data = try? readInput(), !data.isEmpty, data.count <= maxBytes else { fail() }
    defer { data.resetBytes(in: 0..<data.count) }
    guard let session = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          session["version"] as? Int == 1, session["account"] as? String == account,
          session["userAgent"] is String,
          let state = session["storageState"] as? [String: Any], state["cookies"] is [[String: Any]] else { fail() }
    let status = save(service, account, data, update: true)
    guard status == errSecSuccess else { fail(status) }
    let (verified, observed) = read(service, account)
    guard verified == errSecSuccess, observed == data else { fail(verified) }
default:
    fail()
}
