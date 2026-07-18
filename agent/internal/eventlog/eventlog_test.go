package eventlog

import (
	"sync"
	"testing"
)

func TestNoPanicOnAllPlatforms(t *testing.T) {
	// Calling any of these from a non-admin context on Windows, or
	// anywhere on macOS/Linux, must not panic. Registration errors
	// are silently swallowed per package contract.
	Info("Bl4ckAgent", "test info message")
	Warning("Bl4ckAgent", "test warning message")
	Error("Bl4ckAgent", "test error message")
}

func TestConcurrentLogging(t *testing.T) {
	// Verify concurrent calls from multiple goroutines don't panic
	// or race. On non-Windows this exercises the no-op stubs; on
	// Windows it exercises the sync.Mutex + per-source sync.Once
	// guarding lazy registration in lookupOrRegister.
	const numGoroutines = 50
	var wg sync.WaitGroup
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			Info("Bl4ckAgent", "concurrent info")
			Warning("Bl4ckAgent", "concurrent warning")
			Error("Bl4ckAgent", "concurrent error")
		}()
	}
	wg.Wait()
}
