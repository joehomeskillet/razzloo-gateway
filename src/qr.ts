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
