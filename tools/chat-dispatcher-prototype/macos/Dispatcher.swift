import AppKit
import Foundation

final class DispatcherApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var status: NSTextField!
    private var detail: NSTextField!
    private var openButton: NSButton!
    private var retryButton: NSButton!
    private var companion: Process?
    private var timer: Timer?
    private var checking = false
    private var starting = false
    private var quitting = false
    private var ready = false
    private let healthURL = URL(string: "http://127.0.0.1:8794/health")!
    private var extensionID: String { Bundle.main.object(forInfoDictionaryKey: "DispatcherExtensionID") as? String ?? "" }
    private var repository: String { Bundle.main.object(forInfoDictionaryKey: "DispatcherRepository") as? String ?? "PDF-magic/opener" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        makeWindow()
        NSApp.activate(ignoringOtherApps: true)
        check(startIfMissing: true)
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.check(startIfMissing: false) }
    }

    private func makeMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Show Studio Chat Dispatcher", action: #selector(showWindow), keyEquivalent: "0").target = self
        appMenu.addItem(withTitle: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Studio Chat Dispatcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = menu
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 530, height: 365), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Studio Chat Dispatcher"
        window.isReleasedWhenClosed = false
        window.center()
        let content = NSView()
        content.wantsLayer = true
        window.contentView = content
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 15
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 29)
        ])
        let eyebrow = label("STUDIO / WORKSPACE TOOLS", size: 10, color: .secondaryLabelColor)
        let title = label("Chat Dispatcher", size: 27, weight: .semibold)
        let subtitle = label("Your ten chats can work independently of Codex.", size: 13, color: .secondaryLabelColor)
        status = label("Starting local verifier…", size: 14, weight: .medium)
        status.setAccessibilityIdentifier("dispatcher-status")
        detail = label("", size: 12, color: .secondaryLabelColor)
        detail.maximumNumberOfLines = 3
        detail.lineBreakMode = .byWordWrapping
        detail.setAccessibilityIdentifier("dispatcher-detail")
        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.spacing = 10
        openButton = NSButton(title: "Open Dashboard", target: self, action: #selector(openDashboard))
        openButton.bezelStyle = .rounded
        openButton.isEnabled = false
        retryButton = NSButton(title: "Restart Verifier", target: self, action: #selector(restart))
        retryButton.bezelStyle = .rounded
        buttons.addArrangedSubview(openButton)
        buttons.addArrangedSubview(retryButton)
        let note = label("Start and Pause remain in the dashboard. Closing this window keeps the app running; Quit stops the verifier it started.", size: 11, color: .secondaryLabelColor)
        note.maximumNumberOfLines = 3
        note.lineBreakMode = .byWordWrapping
        [eyebrow, title, subtitle, status, detail, buttons, note].forEach(stack.addArrangedSubview)
        detail.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        note.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        window.makeKeyAndOrderFront(nil)
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        return field
    }

    private func check(startIfMissing: Bool) {
        guard !checking, !quitting else { return }
        checking = true
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.checking = false
                if let data = data,
                   let http = response as? HTTPURLResponse, http.statusCode == 200,
                   let health = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   health["service"] as? String == "studio-chat-dispatcher",
                   health["repository"] as? String == self.repository,
                   health["extensionId"] as? String == self.extensionID,
                   health["configured"] as? Bool == true {
                    self.ready = true
                    self.status.stringValue = "Local verifier ready"
                    self.status.textColor = .systemGreen
                    self.detail.stringValue = "\(self.repository) · The app runs this service independently. Dispatch stays under your dashboard's Start and Pause controls."
                    self.openButton.isEnabled = true
                    self.retryButton.isEnabled = true
                    return
                }
                self.ready = false
                self.openButton.isEnabled = false
                if error == nil, response != nil {
                    self.status.stringValue = "Port 8794 is used by a different configuration"
                    self.detail.stringValue = "The app left that service untouched. Quit the previous verifier, then choose Restart Verifier."
                    self.status.textColor = .systemOrange
                } else if startIfMissing, self.companion == nil, !self.starting {
                    self.startCompanion()
                } else if !self.starting {
                    self.status.stringValue = "Local verifier is stopped"
                    self.status.textColor = .systemOrange
                    self.detail.stringValue = "Choose Restart Verifier. Chats keep their existing work; new tasks wait for merge verification."
                }
            }
        }.resume()
    }

    private func startCompanion() {
        guard !quitting, companion == nil else { return }
        guard extensionID.range(of: "^[a-p]{32}$", options: .regularExpression) != nil,
              let resources = Bundle.main.resourceURL else {
            showError("This app needs the installed connector ID. Rebuild with --extension-id.")
            return
        }
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            showError("Node.js was not found in /opt/homebrew/bin or /usr/local/bin.")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [resources.appendingPathComponent("runtime/companion/server.mjs").path, "--repo", repository, "--extension-id", extensionID]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self = self, self.companion === ended else { return }
                self.companion = nil
                self.starting = false
                if !self.quitting {
                    self.showError("The local verifier exited (status \(ended.terminationStatus)). Choose Restart Verifier.")
                }
            }
        }
        do {
            starting = true
            status.stringValue = "Starting local verifier…"
            status.textColor = .labelColor
            retryButton.isEnabled = false
            companion = process
            try process.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.starting = false
                self?.retryButton.isEnabled = true
                self?.check(startIfMissing: false)
            }
        } catch {
            companion = nil
            starting = false
            showError("Could not start Node.js: \(error.localizedDescription)")
        }
    }

    private func showError(_ text: String) {
        status.stringValue = "Local verifier needs attention"
        status.textColor = .systemOrange
        detail.stringValue = text
        openButton.isEnabled = false
        retryButton.isEnabled = true
    }

    @objc private func restart() {
        if let process = companion, process.isRunning {
            companion = nil
            process.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.check(startIfMissing: true) }
        } else {
            companion = nil
            check(startIfMissing: true)
        }
    }

    @objc private func openDashboard() {
        guard ready, let destination = URL(string: "chrome-extension://\(extensionID)/dashboard.html"),
              let brave = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.brave.Browser") else {
            showError("Brave Browser and the Studio connector are required.")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open([destination], withApplicationAt: brave, configuration: configuration) { _, error in
            if error != nil { DispatchQueue.main.async { self.showError("Could not open the dashboard in Brave.") } }
        }
    }

    @objc private func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        timer?.invalidate()
        if let process = companion, process.isRunning { process.terminate() }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = DispatcherApp()
app.delegate = delegate
app.run()
