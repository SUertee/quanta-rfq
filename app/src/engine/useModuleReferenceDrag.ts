import { useEffect, useRef, type RefObject } from "react";
import { citeReference, dragReference, type ChatReference } from "./chatReferences";

/** Only the module heading starts a reference drag. Body text remains selectable. */
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
      touch: boolean;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preview: HTMLDivElement | null = null;
    let nativeSection:HTMLElement|null=null;
    const reset = () => {
      clearTimeout(timer);
      document.body.classList.remove('module-reference-dragging');
      nativeSection?.removeAttribute('data-reference-holding');nativeSection=null;
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
    const arm = () => {
      if (!gesture || gesture.armed) return;
      clearTimeout(timer);
      gesture.armed = true;
      document.body.classList.add('module-reference-dragging');
      window.getSelection()?.removeAllRanges();
      gesture.section.setAttribute('data-reference-holding', 'true');
      node.setPointerCapture?.(gesture.id);
      preview = document.createElement('div');
      preview.className = 'module-reference-ghost';
      preview.textContent = latest.current(gesture.stage).label;
      preview.style.left = `${gesture.x + 14}px`;
      preview.style.top = `${gesture.y + 14}px`;
      document.body.append(preview);
    };
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        event.target.closest('button,input,textarea,select,a,label,summary,[contenteditable],[role=button],[tabindex]:not([tabindex="-1"])')
      )
        return;
      if (!event.target.closest('[data-module-reference]')) return;
      const draggable=event.target.closest('[draggable=true]');
      if(draggable&&(!draggable.hasAttribute('data-module-reference')||event.pointerType!=='touch'))return;
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
        touch: event.pointerType === "touch",
      };
      if (gesture.touch) timer = setTimeout(arm, 450);
      else event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (!gesture.armed) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8) return;
        if (gesture.touch) { reset(); return; }
        arm();
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
    const nativeStart=(event:DragEvent)=>{
      if(!(event.target instanceof Element)||!event.dataTransfer)return;
      const handle=event.target.closest<HTMLElement>('[data-module-reference]');
      const section=handle?.closest<HTMLElement>('[data-inquiry-stage]');
      if(!section)return;
      reset();
      dragReference(event,latest.current(Number(section.dataset.inquiryStage)));
      nativeSection=section;
      section.setAttribute('data-reference-holding','true');
      document.body.classList.add('module-reference-dragging');
    };
    const cancel=()=>{if(!nativeSection)reset();};
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
    node.addEventListener("dragstart",nativeStart);
    window.addEventListener("dragend",reset);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      reset();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("dragstart",nativeStart);
      window.removeEventListener("dragend",reset);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, [root]);
}
