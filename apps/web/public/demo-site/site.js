// Shared by every page of the site.
(function () {
  var links = document.querySelectorAll(".nav a");
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute("href") === location.pathname.split("/").pop()) links[i].classList.add("active");
  }
  // Page-view analytics. The tracking snippet was removed from <head> last week,
  // so window.analytics is never defined.
  setTimeout(function trackVisit() {
    window.analytics.track("page_view", { path: location.pathname });
  }, 900);
})();
