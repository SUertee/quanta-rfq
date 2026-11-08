import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { InquiryStage, WorkflowRun } from "./workflow";

/** Reveal available results in order. Loading comes only from actual processing events. */
export function useWorkflowPresentation(
  taskKey: string,
  run: WorkflowRun | undefined,
  flow: RefObject<HTMLElement>,
) {
  const [shown, setShown] = useState(1);
  const [positions, setPositions] = useState<number[]>([]);
  const available = run?.revealed || 6;
  useEffect(() => setShown(1), [taskKey]);
  useEffect(() => {
    if (shown >= available) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(available);
      return;
    }
    const timer = setTimeout(
      () => setShown((value) => Math.min(value + 1, available)),
      140,
    );
    return () => clearTimeout(timer);
  }, [shown, available, taskKey]);
  useLayoutEffect(() => {
    const root = flow.current;
    if (!root) return;
    const measure = () => {
      const offsets = [
        ...root.querySelectorAll<HTMLElement>("[data-inquiry-stage]"),
      ]
        .filter((node) => !node.hidden)
        .map((node) => node.offsetTop);
      setPositions((old) =>
        old.length === offsets.length &&
        old.every((value, index) => Math.abs(value - offsets[index]) < 1)
          ? old
          : offsets,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [shown, taskKey, flow]);
  return {
    shown: Math.min(shown,available),
    positions,
    busyStage:
      run?.state === "running" ? run.stage : (null as InquiryStage | null),
  };
}
