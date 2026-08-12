package webui

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// The HTTP-layer guards are testable without a machine: they must refuse
// before any connection is attempted.

func testServer(enforce bool) *Server {
	return New(makera.DefaultOptions(), zerolog.Nop(), Config{Token: "sekrit", EnforceToken: enforce})
}

func TestGuardRefusesNonLoopbackHostWithoutToken(t *testing.T) {
	s := testServer(false)
	r := httptest.NewRequest("POST", "/api/jog", strings.NewReader("{}"))
	r.Host = "evil.example:8080" // DNS rebinding: attacker's name resolving to 127.0.0.1
	w := httptest.NewRecorder()
	if s.guardMutation(w, r) {
		t.Fatal("a rebound Host must be refused on a loopback-trust server")
	}
	if w.Code != 403 {
		t.Fatalf("want 403, got %d", w.Code)
	}
}

func TestGuardAcceptsLoopbackHosts(t *testing.T) {
	s := testServer(false)
	for _, host := range []string{"127.0.0.1:8080", "localhost:8080", "[::1]:8080", "app.localhost"} {
		r := httptest.NewRequest("POST", "/api/jog", strings.NewReader("{}"))
		r.Host = host
		w := httptest.NewRecorder()
		if !s.guardMutation(w, r) {
			t.Fatalf("loopback host %q must pass, got %d: %s", host, w.Code, w.Body.String())
		}
	}
}

func TestGuardRefusesCrossOrigin(t *testing.T) {
	s := testServer(false)
	r := httptest.NewRequest("POST", "/api/home", strings.NewReader("{}"))
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Origin", "http://evil.example")
	w := httptest.NewRecorder()
	if s.guardMutation(w, r) {
		t.Fatal("cross-origin mutating request must be refused")
	}
}

func TestGuardRefusesCrossSiteFetchMetadata(t *testing.T) {
	s := testServer(false)
	r := httptest.NewRequest("POST", "/api/home", strings.NewReader("{}"))
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	w := httptest.NewRecorder()
	if s.guardMutation(w, r) {
		t.Fatal("cross-site fetch metadata must be refused")
	}
}

func TestGuardEnforcesTokenWhenRemote(t *testing.T) {
	s := testServer(true)
	r := httptest.NewRequest("POST", "/api/jog", strings.NewReader("{}"))
	r.Host = "192.168.1.50:8080"
	w := httptest.NewRecorder()
	if s.guardMutation(w, r) {
		t.Fatal("remote-reachable server must demand the token")
	}
	if w.Code != 401 {
		t.Fatalf("want 401, got %d", w.Code)
	}

	r2 := httptest.NewRequest("POST", "/api/jog", strings.NewReader("{}"))
	r2.Host = "192.168.1.50:8080"
	r2.Header.Set("X-Z1-Token", "sekrit")
	w2 := httptest.NewRecorder()
	if !s.guardMutation(w2, r2) {
		t.Fatalf("correct token must pass, got %d: %s", w2.Code, w2.Body.String())
	}
}

func TestSameOriginPasses(t *testing.T) {
	s := testServer(false)
	r := httptest.NewRequest("POST", "/api/jog", strings.NewReader("{}"))
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Origin", "http://127.0.0.1:8080")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	if !s.guardMutation(w, r) {
		t.Fatalf("same-origin must pass, got %d: %s", w.Code, w.Body.String())
	}
}
