"use client";

import { useReducedMotion } from "framer-motion";
import { useId } from "react";

/**
 * Animated orb shown above the welcome message: gooey morphing triangles
 * over an amber gradient, slowly hue-shifting (styles: .dzd-loader in
 * app/globals.css).
 *
 * Everything that moves lives inside the SVG and is drawn with SVG
 * features every browser paints the same way, Safari on iPhone included:
 * - the "goo" is an SVG filter (blur, then a sharp alpha threshold), not a
 *   CSS mask pointing at an SVG <mask> (Safari can't apply those to HTML
 *   and showed a plain square);
 * - the triangles turn and the edges soften with SMIL animations, because
 *   Safari ignores CSS animations and filters on shapes inside an SVG.
 */

const DURATION = 2; // seconds per turn (the original --time-animation)

// Alpha threshold: a = k * blurredAlpha - (k / 2 - 0.5), the same curve as
// the original CSS contrast(k). k = 15 is crisp, 3 is soft and round.
const threshold = (k: number) =>
  `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${k} ${0.5 - k / 2}`;
const CRISP = threshold(15);
const SOFT = threshold(3);
const ROUNDNESS = [CRISP, SOFT, SOFT, CRISP, CRISP].join(";");

type Shape = {
  points: string;
  /** Rotation centre in viewBox units (the original transform-origin). */
  cx: number;
  cy: number;
  reverse: boolean;
  /** Start offset as a fraction of a turn (the original negative delay). */
  phase: number;
};

const SHAPES: readonly Shape[] = [
  { cx: 50, cy: 50, phase: 0, points: "25,25 75,25 50,75", reverse: true },
  { cx: 50, cy: 60, phase: 1 / 3, points: "50,25 75,75 25,75", reverse: false },
  { cx: 40, cy: 40, phase: 0, points: "35,35 65,35 50,65", reverse: true },
  { cx: 40, cy: 40, phase: 1 / 2, points: "35,35 65,35 50,65", reverse: true },
  { cx: 60, cy: 40, phase: 0, points: "35,35 65,35 50,65", reverse: false },
  {
    cx: 60,
    cy: 40,
    phase: 1 / 1.5,
    points: "35,35 65,35 50,65",
    reverse: false,
  },
];

/** Where a shape is turned to `seconds` into the animation (degrees). */
export function shapeAngle(shape: Shape, seconds: number) {
  const progress = (seconds / DURATION + shape.phase) % 1;
  return (shape.reverse ? 1 - progress : progress) * 360;
}

const shapeKey = (shape: Shape) =>
  `${shape.points}-${shape.cx}-${shape.cy}-${shape.phase}`;

export function WelcomeLoader() {
  const id = useId().replace(/:/g, "");
  const gooId = `${id}-goo`;
  const fillId = `${id}-fill`;
  const still = useReducedMotion() === true;

  return (
    <div aria-hidden="true" className="dzd-loader">
      <svg
        className="dzd-loader-art"
        height={100}
        viewBox="0 0 100 100"
        width={100}
      >
        <defs>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id={fillId}
            x1={0}
            x2={0}
            y1={0}
            y2={100}
          >
            <stop offset="0.3" stopColor="#ffbf48" />
            <stop offset="0.7" stopColor="#be4a1d" />
          </linearGradient>
          <filter
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
            height={100}
            id={gooId}
            width={100}
            x={0}
            y={0}
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation={7} />
            <feColorMatrix type="matrix" values={CRISP}>
              {still ? null : (
                <animate
                  attributeName="values"
                  dur={`${DURATION / 2}s`}
                  keyTimes="0;0.2;0.4;0.6;1"
                  repeatCount="indefinite"
                  values={ROUNDNESS}
                />
              )}
            </feColorMatrix>
          </filter>
        </defs>
        <g fill={`url(#${fillId})`} filter={`url(#${gooId})`}>
          {SHAPES.map((shape) => {
            const from = shape.reverse ? 360 : 0;
            const to = shape.reverse ? 0 : 360;
            return (
              <polygon
                key={shapeKey(shape)}
                points={shape.points}
                transform={`rotate(${shapeAngle(shape, 0)} ${shape.cx} ${shape.cy})`}
              >
                {still ? null : (
                  <animateTransform
                    attributeName="transform"
                    begin={`${-shape.phase * DURATION}s`}
                    dur={`${DURATION}s`}
                    from={`${from} ${shape.cx} ${shape.cy}`}
                    repeatCount="indefinite"
                    to={`${to} ${shape.cx} ${shape.cy}`}
                    type="rotate"
                  />
                )}
              </polygon>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
