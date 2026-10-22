// Camera access and customer-facing error mapping.

export type Facing = "user" | "environment";

export type CameraErrorKind =
  | "permission_denied"
  | "no_camera"
  | "camera_in_use"
  | "insecure_context"
  | "unsupported"
  | "unknown";

export interface CameraErrorInfo {
  kind: CameraErrorKind;
  title: string;
  message: string;
  canRetry: boolean;
}

export function describeCameraError(err: unknown): CameraErrorInfo {
  const name = (err as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return {
        kind: "permission_denied",
        title: "Camera access is blocked",
        message:
          "To measure your hand we need the camera. Allow camera access for this site in your browser settings (usually the camera or lock icon in the address bar), then try again.",
        canRetry: true,
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return {
        kind: "no_camera",
        title: "No camera found",
        message: "We couldn't find a camera on this device. Connect a camera or open this page on your phone.",
        canRetry: true,
      };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return {
        kind: "camera_in_use",
        title: "The camera is busy",
        message: "Another app may be using the camera. Close other apps or browser tabs that use the camera, then try again.",
        canRetry: true,
      };
    case "SecurityError":
      return {
        kind: "insecure_context",
        title: "Secure connection required",
        message: "Browsers only allow camera access over a secure (https) connection. Open this page using its https address.",
        canRetry: false,
      };
    case "UnsupportedError":
      return {
        kind: "unsupported",
        title: "Camera not supported",
        message: "This browser does not support camera access. Please use a recent version of Chrome, Safari, Edge or Firefox.",
        canRetry: false,
      };
    default:
      return {
        kind: "unknown",
        title: "Camera could not start",
        message: "Something went wrong while starting the camera. Please try again.",
        canRetry: true,
      };
  }
}

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export async function openCamera(facing: Facing, md: MediaDevices | undefined = globalThis.navigator?.mediaDevices): Promise<MediaStream> {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw namedError("SecurityError", "insecure context");
  }
  if (!md || typeof md.getUserMedia !== "function") {
    throw namedError("UnsupportedError", "getUserMedia unavailable");
  }
  // Request 720p on mobile (faster processing, lower power) and 1080p on desktop.
  const mobile = isMobileDevice();
  const idealW = mobile ? 1280 : 1920;
  const idealH = mobile ? 720 : 1080;
  const ideal: MediaStreamConstraints = {
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: idealW }, height: { ideal: idealH } },
  };
  try {
    return await md.getUserMedia(ideal);
  } catch (err) {
    // Some devices reject resolution hints; retry with the simplest request.
    if ((err as { name?: string }).name === "OverconstrainedError") {
      return md.getUserMedia({ audio: false, video: true });
    }
    throw err;
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export function isMobileDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}
