import { useEffect, useRef, type RefObject } from "react";
import { citeReference, type ChatReference } from "./chatReferences";

/** Long press a non-interactive part of a workflow module, then drop it into chat. */
export function useModuleReferenceDrag(
  root: RefObject<HTMLElement>,
  reference: (stage: number) => ChatReference,
) {
  const latest = useRef(reference);
  latest.current = reference;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let gesture: {
      id: number;
      x: number;
      y: number;
      section: HTMLElement;
      stage: number;
      armed: boolean;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preview: HTMLDivElement | null = null;
    const reset = () => {
      clearTimeout(timer);
      preview?.remove();
      preview = null;
      gesture?.section.removeAttribute("data-reference-holding");
      if (gesture && node.hasPointerCapture?.(gesture.id))
        node.releasePointerCapture(gesture.id);
      gesture = null;
      document
        .querySelectorAll("[data-module-drop]")
        .forEach((item) => item.removeAttribute("data-module-drop"));
    };
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        event.target.closest('button,input,textarea,select,a,label,summary,[contenteditable],[role=button],[tabindex]:not([tabindex="-1"]),[draggable=true]')
      )
        return;
      const section = event.target.closest<HTMLElement>("[data-inquiry-stage]");
      if (!section) return;
      reset();
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        section,
        stage: Number(section.dataset.inquiryStage),
        armed: false,
      };
      timer = setTimeout(() => {
        if (!gesture) return;
        gesture.armed = true;
        document.body.classList.add('module-reference-dragging');
        window.getSelection()?.removeAllRanges();
        section.setAttribute("data-reference-holding", "true");
        node.setPointerCapture?.(gesture.id);
        preview = document.createElement("div");
        preview.className = "module-reference-ghost";
        preview.textContent = latest.current(gesture.stage).label;
        preview.style.left = `${gesture.x + 14}px`;
        preview.style.top = `${gesture.y + 14}px`;
        document.body.append(preview);
      }, 450);
    };
    const move = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (!gesture.armed) {
        if (
          Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8
        )
          reset();
        return;
      }
      event.preventDefault();
      if (preview) {
        preview.style.left = `${event.clientX + 14}px`;
        preview.style.top = `${event.clientY + 14}px`;
      }
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest(".rfq-chat-composer,.platform-chat-form");
      document.querySelectorAll("[data-module-drop]").forEach((item) => {
        if (item !== target) item.removeAttribute("data-module-drop");
      });
      target?.setAttribute("data-module-drop", "true");
    };
    const up = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (gesture.armed) {
        event.preventDefault();
        if (
          document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest(".rfq-chat-composer,.platform-chat-form")
        )
          citeReference(latest.current(gesture.stage));
      }
      reset();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
      if (
        event.key === "Enter" &&
        event.altKey &&
        event.target instanceof Element
      ) {
        const section = event.target.closest<HTMLElement>(
          "[data-inquiry-stage]",
        );
        if (section) {
          event.preventDefault();
          citeReference(latest.current(Number(section.dataset.inquiryStage)));
        }
      }
    };
    node.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", reset);
    window.addEventListener("keydown", escape);
    return () => {
      reset();
      node.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("keydown", escape);
    };
  }, [root]);
}
