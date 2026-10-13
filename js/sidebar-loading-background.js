(() => {
  const root = document.documentElement;
  if (!root || document.readyState === "complete") return;

  const attribute = "data-ghrc-sidebar-loading";
  root.setAttribute(attribute, "true");

  const finish = () => root.removeAttribute(attribute);
  window.addEventListener("load", finish, { once: true });
  window.addEventListener("pageshow", finish, { once: true });
  // Fail open if a resource prevents the load event from firing.
  window.setTimeout(finish, 8000);
})();
