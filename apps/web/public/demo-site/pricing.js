// Pricing page: billing period, the price with tax, the trial form.
(function () {
  var PRICES = { team: { monthly: 29, yearly: 23 }, business: { monthly: 79, yearly: null } };

  function order(body) {
    return fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function setPeriod(period) {
    document.querySelectorAll(".toggle button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-period") === period);
    });
    Object.keys(PRICES).forEach(function (plan) {
      var price = PRICES[plan][period];
      if (price == null) {
        console.warn('[pricing] Plan "' + plan + '" has no ' + period + " price, showing the monthly one");
        price = PRICES[plan].monthly;
      }
      var el = document.querySelector('[data-plan="' + plan + '"] .amount');
      if (el) el.textContent = "$" + price;
    });
  }

  document.querySelectorAll(".toggle button").forEach(function (b) {
    b.addEventListener("click", function () { setPeriod(b.getAttribute("data-period")); });
  });

  // The price with tax for the featured plan.
  setTimeout(function () {
    setPeriod("yearly");
    order({ plan: "team", period: "yearly", preview: true }).then(function (res) {
      var tax = document.getElementById("team-tax");
      if (!res.ok) {
        console.error("Order preview failed: " + res.status + " " + res.statusText);
        tax.textContent = "Couldn't load the price with tax";
        tax.classList.add("err");
        return;
      }
      return res.json().then(function (data) { tax.textContent = "$" + data.total + " with tax"; });
    });
  }, 1100);

  function startTrial(plan) {
    var msg = document.getElementById("form-msg");
    msg.textContent = "Starting your trial…";
    msg.className = "form-msg";
    var form = document.getElementById("trial-form");
    order({ plan: plan, email: form.email.value, company: form.company.value }).then(function (res) {
      if (!res.ok) {
        msg.textContent = "Something went wrong. Please try again.";
        msg.className = "form-msg err";
        console.error("Trial signup failed: " + res.status);
        return;
      }
      msg.textContent = "Check your email.";
    });
  }

  document.getElementById("trial-form").addEventListener("submit", function (e) {
    e.preventDefault();
    startTrial("team");
  });
  document.querySelector('[data-start="team"]').addEventListener("click", function () {
    document.getElementById("trial").scrollIntoView({ behavior: "smooth" });
  });
})();
