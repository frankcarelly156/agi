// Run before parsing the page so browser history cannot restore an old offset.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
document.documentElement.classList.add('resetting-scroll');

window.addEventListener('pageshow', () => {
  document.documentElement.classList.add('resetting-scroll');
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('resetting-scroll');
    });
  });
});
