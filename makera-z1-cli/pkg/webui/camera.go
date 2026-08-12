package webui

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-go-golems/makera-z1-cli/pkg/makera"
)

// Camera routes.
//
// The camera is a separate service on the machine's WiFi module (WebSocket on
// port 82) and never touches the control connection, so the stream route is a
// plain GET with no machine-state implications. The server bridges the
// WebSocket to MJPEG (multipart/x-mixed-replace) because an <img> tag can
// render that with no client code at all. One bridge per viewer; whether the
// module accepts several concurrent stream clients is untested, so one tab at
// a time is the supported shape.

func (s *Server) handleCameraProbe(w http.ResponseWriter, r *http.Request) {
	host := makera.CameraHost(s.opts.Address)
	writeJSON(w, http.StatusOK, map[string]any{
		"camera": makera.HasCamera(r.Context(), host),
		"host":   host,
	})
}

func (s *Server) handleCameraStream(w http.ResponseWriter, r *http.Request) {
	host := makera.CameraHost(s.opts.Address)
	cam, err := makera.DialCamera(r.Context(), host)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer func() { _ = cam.Close() }()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
	w.Header().Set("Cache-Control", "no-store")

	for {
		frame, err := cam.NextFrame(10 * time.Second)
		if err != nil {
			return // orderly close, timeout or viewer gone — nothing to report mid-stream
		}
		if _, err := fmt.Fprintf(w, "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n", len(frame)); err != nil {
			return
		}
		if _, err := w.Write(frame); err != nil {
			return
		}
		if _, err := fmt.Fprint(w, "\r\n"); err != nil {
			return
		}
		flusher.Flush()
		if r.Context().Err() != nil {
			return
		}
	}
}

type cameraResBody struct {
	Value int `json:"value"`
}

func (s *Server) handleCameraResolution(w http.ResponseWriter, r *http.Request) {
	var b cameraResBody
	if !decodeBody(w, r, &b) {
		return
	}
	host := makera.CameraHost(s.opts.Address)
	if err := makera.SetCameraResolution(r.Context(), host, b.Value); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
