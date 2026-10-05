import AppKit
import Security

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let alert = NSAlert()
alert.messageText = "Configure Flawless ChatGPT login"
alert.informativeText = "Generate a client secret in your flawless-chatgpt GitHub App settings, then paste it here. It will be saved in macOS Keychain for the local login service. It will not be saved in the extension or repository."
alert.addButton(withTitle: "Save to Keychain")
alert.addButton(withTitle: "Cancel")
let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 28))
field.placeholderString = "GitHub App client secret"
alert.accessoryView = field
app.activate(ignoringOtherApps: true)
alert.window.initialFirstResponder = field
guard alert.runModal() == .alertFirstButtonReturn else { exit(1) }
let secret = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
guard !secret.isEmpty else { exit(1) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "flawless-chatgpt-auth",
    kSecAttrAccount as String: "Iv23liukJaqMAIiIIfOz",
]
let values: [String: Any] = [kSecValueData as String: Data(secret.utf8)]
let updated = SecItemUpdate(query as CFDictionary, values as CFDictionary)
var result = updated
if updated == errSecItemNotFound {
    result = SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil)
}
guard result == errSecSuccess else {
    fputs("Could not save the login credential to Keychain.\n", stderr)
    exit(1)
}
print("GitHub login credential saved in Keychain.")
