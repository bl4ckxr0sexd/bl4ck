// agent/installer/macos-app/Sources/Bl4ckInstaller/Views/InstallingView.swift
import SwiftUI

struct InstallingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Installing BL4CK Agent…")
                .font(.headline)
            Text("This usually takes about 10 seconds.")
                .foregroundStyle(.secondary)
                .font(.subheadline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
