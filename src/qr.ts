// QR SVG for the join page. Thin wrapper over the `qrcode` library so the
// gateway serves a standard, scannable QR same-origin (no external CDN). The
// payload is the host's candidate URL, for top-level navigation (F4).

import QRCode from "qrcode";

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    margin: 2,
    errorCorrectionLevel: "M",
  });
}

// Generic placeholder for unknown/expired/locked codes (H2). Returning a 200
// SVG of the same shape keeps the qr.svg route from being an existence oracle
// or a brute-force bypass: every code yields an SVG, only valid ones encode a
// real host URL. Static literal (no untrusted input).
export async function qrPlaceholderSvg(): Promise<string> {
  return qrSvg("razzoozle");
}
