/* Scroll position controls the flight and statement. Native scrolling stays intact. */
(() => {
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = value => Math.max(0, Math.min(1, value));
  const statement = document.getElementById('statement');
  const atmosphere = document.querySelector('.atmo');
  const route = document.getElementById('flight-route');
  const plumeRim = document.getElementById('flight-plume-rim');
  const plumeCore = document.getElementById('flight-plume-core');
  const plane = document.getElementById('flight-plane');
  const headlineElement = document.getElementById('h1');
  const description = document.querySelector('.hero .trust');

  function splitText(id) {
    const element = document.getElementById(id);
    element.setAttribute('aria-label', element.textContent);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const letters = [];
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      for (const character of node.textContent) {
        const letter = document.createElement('span');
        letter.className = 'letter';
        if (/\s/.test(character)) letter.style.whiteSpace = 'pre';
        letter.setAttribute('aria-hidden', 'true');
        letter.textContent = character;
        fragment.append(letter);
        letters.push(letter);
      }
      node.replaceWith(fragment);
    }
    return letters;
  }

  const headline = splitText('h1');
  const letters = splitText('stmt');
  let queued = false;
  let introFrame = 0;
  let initialPlaneY = 0;
  let aircraftScale = 1;

  function measure() {
    route.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
    const headlineBottom = headlineElement.getBoundingClientRect().bottom + scrollY;
    const descriptionTop = description.getBoundingClientRect().top + scrollY;
    const availableHeight = descriptionTop - headlineBottom;
    initialPlaneY = (headlineBottom + descriptionTop) / 2;
    aircraftScale = Math.max(.55, Math.min(1.9, innerWidth / 550, (availableHeight - 48) / 110));
    render();
  }

  // Anchor the plume to the top of the aircraft image, behind the tail.
  function drawFlight() {
    const width = innerWidth;
    const height = innerHeight;
    const progress = motionPreference.matches ? 0 : scrollY / height;
    const tip = initialPlaneY + progress * height * .22;
    const center = width / 2;
    const spread = width * (1 + progress * .32);
    const top = -height * .25;
    const scale = aircraftScale;
    function bowl(bottom, breadth) {
      return `M ${center - breadth * .72} ${top}
        C ${center - breadth * .48} ${bottom * .38}, ${center - breadth * .24} ${bottom}, ${center} ${bottom}
        C ${center + breadth * .24} ${bottom}, ${center + breadth * .48} ${bottom * .38}, ${center + breadth * .72} ${top} Z`;
    }
    const tail = tip - 52 * scale;
    plumeRim.setAttribute('d', bowl(tail, spread * 1.06));
    plumeCore.setAttribute('d', bowl(tail - 12 * scale, spread));
    plane.setAttribute('transform', `translate(${center} ${tip}) scale(${scale})`);
    atmosphere.style.opacity = String(1 - clamp((progress - .4) / 1.1));
  }

  function render() {
    queued = false;
    const sectionTop = statement.getBoundingClientRect().top;
    const progress = clamp(-sectionTop / Math.max(1, statement.offsetHeight - innerHeight));
    const visibleCount = Math.ceil(clamp((progress - .02) / .8) * letters.length);
    letters.forEach((letter, index) => {
      letter.classList.toggle('is-pending', !motionPreference.matches && index >= visibleCount);
    });
    drawFlight();
  }

  function scheduleRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(render);
  }

  function revealHeadline(start) {
    function step(now) {
      const count = Math.ceil(clamp((now - start) / 1100) * headline.length);
      headline.forEach((letter, index) => { letter.style.opacity = index < count ? '1' : '0'; });
      if (count < headline.length && !motionPreference.matches) introFrame = requestAnimationFrame(step);
      else headline.forEach(letter => { letter.style.opacity = '1'; });
    }
    introFrame = requestAnimationFrame(step);
  }

  addEventListener('scroll', scheduleRender, { passive: true });
  addEventListener('resize', measure);
  motionPreference.addEventListener('change', () => {
    cancelAnimationFrame(introFrame);
    headline.forEach(letter => { letter.style.opacity = '1'; });
    measure();
  });
  measure();
  document.fonts.ready.then(measure);
  if (!motionPreference.matches) revealHeadline(performance.now());
})();
