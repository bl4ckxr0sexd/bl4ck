// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Bl4ckInstaller",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "Bl4ckInstaller", targets: ["Bl4ckInstaller"]),
    ],
    targets: [
        .executableTarget(
            name: "Bl4ckInstaller",
            path: "Sources/Bl4ckInstaller"
        ),
        .testTarget(
            name: "Bl4ckInstallerTests",
            dependencies: ["Bl4ckInstaller"],
            path: "Tests/Bl4ckInstallerTests"
        ),
    ]
)
