import {useLayoutEffect, useRef, useState} from 'react';
import type {InquiryStage} from './workflow';

/** View location is independent of business completion and approval. */
export function useStageNavigation(taskKey: string) {
  const [stage, setStage] = useState<InquiryStage>(1);
  const flowRef = useRef<HTMLElement>(null);
  const navigation = useRef<{target: InquiryStage; timer: ReturnType<typeof setTimeout>} | null>(null);
  const scrollContainer = () => flowRef.current?.closest<HTMLElement>('.content');
  const visibleBounds = () => {
    const rect = scrollContainer()?.getBoundingClientRect();
    return {top:rect?.top ?? 0, bottom:Math.min(rect?.bottom ?? window.innerHeight,window.innerHeight)};
  };
  const goToStage = (next: InquiryStage) => {
    const section = flowRef.current?.querySelector<HTMLElement>(`[data-inquiry-stage="${next}"]`);
    if (!section || section.hidden) return;
    if (navigation.current) clearTimeout(navigation.current.timer);
    navigation.current = {target: next, timer: setTimeout(() => { navigation.current = null; }, 1800)};
    setStage(next);
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const container = scrollContainer();
    if (container) {
      container.scrollTo({top:container.scrollTop + section.getBoundingClientRect().top - visibleBounds().top - 24,behavior});
    } else {
      section.scrollIntoView({behavior,block:'start'});
    }
    section.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    let frame = 0;
    setStage(1);
    // A newly opened inquiry always starts at its own heading.
    scrollContainer()?.scrollTo({top:0,behavior:'instant' as ScrollBehavior});
    const update = () => {
      frame = 0;
      if (navigation.current) return;
      const sections = [...(flowRef.current?.querySelectorAll<HTMLElement>('[data-inquiry-stage]') ?? [])].filter(node=>!node.hidden);
      if (!sections.length) return;
      const bounds = visibleBounds();
      const anchor = scrollContainer() ? bounds.top + 32 : Math.min(160, window.innerHeight * .25);
      const passed = sections.filter(node => node.getBoundingClientRect().top <= anchor);
      const last = sections[sections.length - 1];
      const lastRect = last.getBoundingClientRect();
      const current = lastRect.top < bounds.bottom && lastRect.bottom <= bounds.bottom + 8
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
