import XCTest
@testable import Bl4ckInstaller

final class ArchitectureTests: XCTestCase {
    func testMapsArm64() {
        XCTAssertEqual(Architecture.fromUname("arm64\n"), .arm64)
        XCTAssertEqual(Architecture.fromUname("arm64"), .arm64)
    }

    func testMapsAmd64() {
        XCTAssertEqual(Architecture.fromUname("x86_64\n"), .amd64)
        XCTAssertEqual(Architecture.fromUname("x86_64"), .amd64)
    }

    func testRejectsUnknown() {
        XCTAssertNil(Architecture.fromUname("ppc"))
        XCTAssertNil(Architecture.fromUname(""))
    }

    func testPickPkgFilenames() {
        XCTAssertEqual(Architecture.arm64.pkgResourceName, "bl4ck-agent-arm64.pkg")
        XCTAssertEqual(Architecture.amd64.pkgResourceName, "bl4ck-agent-amd64.pkg")
    }
}
