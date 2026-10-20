import type { Transition, Variants } from "motion/react";

// Shared motion vocabulary. The curve and distances match the CSS --ease-out and the
// page-in keyframes in styles.css, so Motion-driven lists and CSS-driven pages feel alike.
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// Lists rise in one after another, but only the first few wait: a long file list
// should not take seconds to settle.
const STAGGER = 0.035;
const STAGGER_CAP = 8;

export const listIn: Variants = { hidden: {}, visible: {} };

export const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: EASE_OUT, delay: Math.min(i, STAGGER_CAP) * STAGGER },
  }),
};

// Props for a list container whose motion children use `rise` with `custom={index}`.
export const staggered = { variants: listIn, initial: "hidden", animate: "visible" } as const;

// Quick, slightly springy settle for small state changes (star, counters, tab underline).
export const snappy: Transition = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 };
