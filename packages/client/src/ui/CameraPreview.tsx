/**
 * The camera preview thumbnail.
 *
 * This is a mirror, not a viewfinder: it exists so the player can confirm they
 * are in frame and see which joints the model has found. It draws on its own
 * 20 Hz timer rather than in the game loop, because it is worth roughly nothing
 * per frame to the gameplay and should never compete with it for time.
 *
 * The pixels stay in this canvas. Nothing here is uploaded, recorded, or sent.
 */

import { useEffect, useRef } from 'react';
import { LM } from '@graufence/shared';
import type { Landmark } from '@graufence/shared';
import { drawPreview, loadOpenCv } from '../cv/preprocess.js';
import type { OpenCV } from '../cv/preprocess.js';
import { PALETTE } from '../render/palette.js';

/** The joints that make the punch and stance readable in the preview. */
const BONES: [number, number][] = [
  [LM.nose, LM.leftShoulder],
  [LM.nose, LM.rightShoulder],
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee],
  [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee],
  [LM.rightKnee, LM.rightAnkle],
];

export interface CameraPreviewProps {
  video: HTMLVideoElement;
  getLandmarks: () => Landmark[];
  /** Run the OpenCV contrast lift. Off by default; see cv/preprocess.ts. */
  enhance?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

export function CameraPreview({
  video,
  getLandmarks,
  enhance = false,
  width = 240,
  height = 180,
  className,
}: CameraPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cvRef = useRef<OpenCV | null>(null);

  useEffect(() => {
    if (!enhance) return;
    let cancelled = false;
    void loadOpenCv().then((cv) => {
      if (!cancelled) cvRef.current = cv;
    });
    return () => {
      cancelled = true;
    };
  }, [enhance]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const timer = setInterval(() => {
      if (video.readyState < 2) return;
      drawPreview(cvRef.current, video, canvas, { mirror: true, enhance });

      const landmarks = getLandmarks();
      if (landmarks.length === 0) {
        ctx.fillStyle = 'rgba(8, 12, 22, 0.72)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = PALETTE.warn;
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('no body detected', canvas.width / 2, canvas.height / 2);
        return;
      }

      // Mirror the overlay the same way the image is mirrored, or the skeleton
      // lands on the wrong side of the player and looks broken.
      const px = (l: Landmark) => ({
        x: (1 - l.x) * canvas.width,
        y: l.y * canvas.height,
      });

      ctx.lineWidth = 2;
      ctx.strokeStyle = PALETTE.self;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        const la = landmarks[a];
        const lb = landmarks[b];
        if (!la || !lb) continue;
        // Low-visibility joints are guesses; drawing them confidently would
        // make a bad reading look like a good one.
        if ((la.visibility ?? 1) < 0.4 || (lb.visibility ?? 1) < 0.4) continue;
        const pa = px(la);
        const pb = px(lb);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();

      for (const index of Object.values(LM)) {
        const l = landmarks[index];
        if (!l || (l.visibility ?? 1) < 0.4) continue;
        const p = px(l);
        ctx.fillStyle = PALETTE.self;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }, 50);

    return () => clearInterval(timer);
  }, [video, getLandmarks, enhance]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className ?? 'camera-preview'}
      aria-label="Your camera preview. This video never leaves your computer."
    />
  );
}
