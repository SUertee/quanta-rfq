import {useEffect, useRef, useState} from 'react';
import type {InquiryStage} from './workflow';

/** View location is independent of business completion and approval. */
export function useStageNavigation(taskKey: string) {
  const [stage, setStage] = useState<InquiryStage>(1);
  const flowRef = useRef<HTMLElement>(null);
  const navigation = useRef<{target: InquiryStage; timer: ReturnType<typeof setTimeout>} | null>(null);
  const goToStage = (next: InquiryStage) => {
    const section = flowRef.current?.querySelector<HTMLElement>(`[data-inquiry-stage="${next}"]`);
    if (!section) return;
    if (navigation.current) clearTimeout(navigation.current.timer);
    navigation.current = {target: next, timer: setTimeout(() => { navigation.current = null; }, 1800)};
    setStage(next);
    section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    section.focus({ preventScroll: true });
  };
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (navigation.current) return;
      const sections = [...(flowRef.current?.querySelectorAll<HTMLElement>('[data-inquiry-stage]') ?? [])];
      if (!sections.length) return;
      const anchor = Math.min(160, window.innerHeight * .25);
      const passed = sections.filter(node => node.getBoundingClientRect().top <= anchor);
      const last = sections[sections.length - 1];
      const lastRect = last.getBoundingClientRect();
      const current = lastRect.top < window.innerHeight && lastRect.bottom <= window.innerHeight + 8
        ? last : passed[passed.length - 1] ?? sections[0];
      setStage(Number(current.dataset.inquiryStage) as InquiryStage);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const finishNavigation = () => { navigation.current = null; schedule(); };
    const onScroll = () => {
      if (navigation.current) {
        clearTimeout(navigation.current.timer);
        navigation.current.timer = setTimeout(finishNavigation, 160);
      }
      schedule();
    };
    const interrupt = () => {
      if (navigation.current) clearTimeout(navigation.current.timer);
      finishNavigation();
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)) interrupt();
    };
    // Capture also catches a scrolling application container, not just window scroll.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('wheel', interrupt, {passive:true});
    window.addEventListener('touchstart', interrupt, {passive:true});
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    if (flowRef.current) observer.observe(flowRef.current);
    schedule();
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', interrupt);
      window.removeEventListener('touchstart', interrupt);
      window.removeEventListener('keydown', onKey);
      if (navigation.current) clearTimeout(navigation.current.timer);
      navigation.current = null;
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [taskKey]);
  return {stage, flowRef, goToStage};
}
