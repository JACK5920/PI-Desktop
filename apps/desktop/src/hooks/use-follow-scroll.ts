import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type UIEventHandler,
} from "react";
import {
  isRecentScrollGesture,
  isScrollGestureInput,
  isUpwardScrollIntent,
  reduceTranscriptScroll,
  TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
  type ScrollInputType,
} from "../lib/transcript-scroll";
import { readScrollInputContext, stopSmoothScroll } from "../lib/scroll-input";
import type { DisclosureAnchorNotifier } from "../lib/disclosure-anchor-context";
import { useDisclosureAnchor } from "./use-disclosure-anchor";

const SCROLL_INPUT_EVENTS: readonly ScrollInputType[] = [
  "wheel",
  "touchstart",
  "touchmove",
  "pointerdown",
  "keydown",
];

function attachScrollInput(
  element: HTMLElement,
  handler: (event: Event) => void,
): void {
  for (const type of SCROLL_INPUT_EVENTS) {
    element.addEventListener(type, handler, { passive: true });
  }
}

function detachScrollInput(
  element: HTMLElement,
  handler: (event: Event) => void,
): void {
  for (const type of SCROLL_INPUT_EVENTS) {
    element.removeEventListener(type, handler);
  }
}

export type FollowScroll = {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  showJump: boolean;
  handleScroll: UIEventHandler<HTMLDivElement>;
  jumpToLatest: () => void;
  scheduleFollowScroll: () => void;
  releaseFollow: () => void;
  /** Provided around this scroller's rows so their disclosures can hold it. */
  disclosureAnchorNotifier: DisclosureAnchorNotifier;
};

/**
 * Stick-to-bottom follow for a nested scroller (D302).
 *
 * Same contract as the main transcript: pin on mount, follow while pinned,
 * release only on a real upward gesture, and re-pin from a jump control.
 * Layout clamps and programmatic `scrollTo` never count as a user gesture.
 * A manual disclosure holds its own reading position here too (#324), and the
 * hold also reaches the scroller this one is nested in, because growing these
 * rows grows that one's content as well.
 */
export function useFollowScroll(): FollowScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastScrollGestureAtRef = useRef(-Infinity);
  const followFrameRef = useRef(0);
  const boundScrollRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<{
    observer: ResizeObserver;
    content: HTMLDivElement;
    scroller: HTMLDivElement;
  } | null>(null);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    const targetTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: targetTop, behavior });
    // Record the position the scroller actually reached, not the one that was
    // asked for: a fractional device pixel ratio lands a fraction of a pixel
    // away, and the intended value would make the following native scroll event
    // read as the user scrolling up.
    if (behavior === "auto") lastScrollTopRef.current = el.scrollTop;
  }, []);

  const cancelFollowScroll = useCallback(() => {
    cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = 0;
  }, []);

  const recordScrollPosition = useCallback((top: number) => {
    lastScrollTopRef.current = top;
  }, []);
  const {
    notifier: disclosureAnchorNotifier,
    restore: restoreDisclosureAnchor,
    release: releaseDisclosureAnchor,
    isHeld: isDisclosureAnchorHeld,
  } = useDisclosureAnchor(
    scrollRef,
    useCallback(() => {
      stopSmoothScroll(scrollRef.current);
      cancelFollowScroll();
      pinnedRef.current = false;
      setShowJump(true);
    }, [cancelFollowScroll]),
    recordScrollPosition,
  );

  const markScrollGesture = useCallback(
    (event: Event) => {
      const input = readScrollInputContext(
        event,
        scrollRef.current,
        contentRef.current,
      );
      if (!isScrollGestureInput(event.type as ScrollInputType, input)) return;
      stopSmoothScroll(scrollRef.current);
      lastScrollGestureAtRef.current = performance.now();
      releaseDisclosureAnchor();
      // Take ownership as soon as the reader asks to move upward, rather than
      // waiting for a scroll event. A queued ResizeObserver/rAF follow between
      // wheel and scroll delivery would otherwise pull the viewport back down.
      if (isUpwardScrollIntent(event.type as ScrollInputType, input)) {
        cancelFollowScroll();
        pinnedRef.current = false;
        setShowJump(true);
      }
    },
    [cancelFollowScroll, releaseDisclosureAnchor],
  );

  const scheduleFollowScroll = useCallback(() => {
    // A queued follow frame must not move the title the reader just toggled:
    // the observer below already refuses to, and this path would undo it.
    if (!pinnedRef.current || followFrameRef.current !== 0) return;
    if (isDisclosureAnchorHeld()) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = 0;
      if (pinnedRef.current) scrollToBottom();
    });
  }, [isDisclosureAnchorHeld, scrollToBottom]);

  // Re-pin in the observer callback itself (D287): a rAF scheduled from
  // ResizeObserver paints one unpinned frame before the follow lands. A held
  // disclosure position takes precedence — it is what keeps the clicked title
  // still while the dock's rows animate. (`useDisclosureAnchor` already passes
  // this hold outward to the scroller this one is nested in.)
  const followScrollNow = useCallback(() => {
    if (restoreDisclosureAnchor()) return;
    if (!pinnedRef.current) return;
    cancelFollowScroll();
    scrollToBottom();
  }, [cancelFollowScroll, restoreDisclosureAnchor, scrollToBottom]);

  // The scroller can mount after this hook does: the OMP subagent detail
  // renders it only once an agent is selected. Bindings therefore follow the
  // node instead of running once on mount. Without this, that late scroller
  // never records input, every real scroll-up is read as a layout clamp, and
  // the follow frame keeps dragging the reader back to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (boundScrollRef.current !== el) {
      const previous = boundScrollRef.current;
      if (previous) detachScrollInput(previous, markScrollGesture);
      boundScrollRef.current = el;
      if (el) {
        attachScrollInput(el, markScrollGesture);
        // A scroller that arrives late opens pinned on its latest content.
        releaseDisclosureAnchor();
        cancelFollowScroll();
        pinnedRef.current = true;
        setShowJump(false);
        scrollToBottom();
      }
    }
    const content = contentRef.current;
    const bound = resizeObserverRef.current;
    if (bound?.content === content && bound?.scroller === el) return;
    bound?.observer.disconnect();
    resizeObserverRef.current = null;
    if (!content || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(followScrollNow);
    observer.observe(content, { box: "border-box" });
    observer.observe(el, { box: "border-box" });
    resizeObserverRef.current = { observer, content, scroller: el };
  });

  // Unmount only: the effect above re-binds as nodes change and owns no
  // cleanup of its own.
  useEffect(
    () => () => {
      if (boundScrollRef.current) {
        detachScrollInput(boundScrollRef.current, markScrollGesture);
      }
      resizeObserverRef.current?.observer.disconnect();
    },
    [markScrollGesture],
  );

  useEffect(() => cancelFollowScroll, [cancelFollowScroll]);
  useEffect(() => releaseDisclosureAnchor, [releaseDisclosureAnchor]);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasPinned = pinnedRef.current;
    // Real input is compared exactly; without it, sub-pixel slack keeps a
    // fractional device pixel ratio from reading as the user scrolling up.
    const gesturing = isRecentScrollGesture(
      performance.now(),
      lastScrollGestureAtRef.current,
    );
    const transition = reduceTranscriptScroll({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      wasPinned,
      tolerancePx: gesturing ? 0 : TRANSCRIPT_SCROLL_ROUNDING_TOLERANCE_PX,
    });
    lastScrollTopRef.current = el.scrollTop;
    if (transition.releasedFollow) cancelFollowScroll();
    if (gesturing && transition.releasedFollow) {
      pinnedRef.current = false;
      setShowJump(true);
    } else if (transition.releasedFollow) {
      pinnedRef.current = wasPinned;
      setShowJump(!wasPinned);
      scheduleFollowScroll();
    } else {
      pinnedRef.current = transition.pinned;
      setShowJump(transition.showJump);
    }
  }, [cancelFollowScroll, scheduleFollowScroll]);

  const jumpToLatest = useCallback(() => {
    releaseDisclosureAnchor();
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    );
  }, [releaseDisclosureAnchor, scrollToBottom]);

  const releaseFollow = useCallback(() => {
    stopSmoothScroll(scrollRef.current);
    releaseDisclosureAnchor();
    cancelFollowScroll();
    pinnedRef.current = false;
    setShowJump(true);
  }, [cancelFollowScroll, releaseDisclosureAnchor]);

  return {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    disclosureAnchorNotifier,
  };
}

