import type { LiveOwner } from "../live-voice/call-service";

type HeldLease = { sessionId: string; owner: LiveOwner; releaseCapture: () => void };
const ownerKey = (owner: LiveOwner) => `${owner.webContentsId}:${owner.frameProcessId}:${owner.frameRoutingId}:${owner.url}`;

/** Allows the trusted OMP RPC renderer path to capture WebRTC audio while
 * sharing the app-wide microphone exclusivity lease with dictation/live voice. */
export class OmpMicrophoneLeaseRegistry {
  private held: HeldLease | null = null;
  constructor(private readonly acquireCapture: (token: string) => () => void) {}

  acquire(sessionId: string, owner: LiveOwner): void {
    if (this.held) {
      if (this.held.sessionId === sessionId && ownerKey(this.held.owner) === ownerKey(owner)) return;
      throw Object.assign(new Error("麦克风正被另一个功能占用"), { errorCode: "LIVE_MICROPHONE_BUSY" });
    }
    const token = `omp-live:${sessionId}:${ownerKey(owner)}`;
    this.held = { sessionId, owner, releaseCapture: this.acquireCapture(token) };
  }

  release(sessionId: string, owner: LiveOwner): boolean {
    if (!this.held || this.held.sessionId !== sessionId || ownerKey(this.held.owner) !== ownerKey(owner)) return false;
    this.held.releaseCapture();
    this.held = null;
    return true;
  }

  releaseSession(sessionId: string): void {
    if (!this.held || this.held.sessionId !== sessionId) return;
    this.held.releaseCapture();
    this.held = null;
  }

  releaseForWebContents(webContentsId: number): void {
    if (!this.held || this.held.owner.webContentsId !== webContentsId) return;
    this.held.releaseCapture();
    this.held = null;
  }

  releaseAll(): void {
    if (!this.held) return;
    this.held.releaseCapture();
    this.held = null;
  }

  hasReservation(owner: LiveOwner): boolean {
    return this.held !== null && ownerKey(this.held.owner) === ownerKey(owner);
  }
}
