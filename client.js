// dsh-foundry client half — the Plugin Foundry blueprint-gallery settings page.
// Loaded as a classic script by the client-modules bundle route; the factory
// returns a standard Cordis plugin { apply, inject }.
window.__ModuleLoader__.load({
  id: "dsh-foundry",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var inject = ["slots"];

    function categoryChip(cat) {
      return React.createElement(
        "span",
        { style: { textTransform: "uppercase", fontSize: "10px", letterSpacing: ".06em", opacity: .55 } },
        cat
      );
    }

    function paramChip(p) {
      return React.createElement(
        "span",
        { key: p.name, style: { fontSize: "10px", padding: "2px 6px", borderRadius: "6px", background: "rgba(120,180,255,.15)", fontFamily: "monospace" } },
        p.name + (p.required ? "*" : "")
      );
    }

    function BlueprintCard(bp) {
      return React.createElement(
        "div",
        { key: bp.id, style: { border: "1px solid rgba(0,0,0,.12)", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "6px" } },
        React.createElement(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
          React.createElement("span", { style: { fontWeight: 600, fontSize: "14px" } }, bp.name),
          React.createElement("span", { style: { fontSize: "11px", opacity: .55, fontFamily: "monospace" } }, bp.id)
        ),
        categoryChip(bp.category),
        React.createElement("div", { style: { fontSize: "12px", opacity: .85, lineHeight: 1.5 } }, bp.description),
        React.createElement(
          "div",
          { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
          (bp.params || []).map(paramChip)
        )
      );
    }

    function FoundrySection() {
      var state = React.useState(null);
      var data = state[0];
      var setData = state[1];

      function load() {
        fetch("/foundry/state")
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (d) { setData(d); })
          .catch(function (e) { setData({ error: String((e && e.message) || e) }); });
      }

      React.useEffect(function () {
        load();
        return function () {};
      }, []);

      var blueprints = data && data.blueprints ? data.blueprints : [];

      return React.createElement(
        "div",
        { style: { padding: "20px", display: "flex", flexDirection: "column", gap: "16px" } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          React.createElement("h2", { style: { margin: 0 } }, "🔨 Plugin Foundry — blueprints"),
          React.createElement("button", { onClick: load, style: { padding: "6px 12px", cursor: "pointer" } }, "Refresh")
        ),
        data && data.error
          ? React.createElement("div", { style: { color: "#c0392b" } }, "Error: " + data.error)
          : null,
        data === null ? React.createElement("div", null, "Loading…") : null,
        React.createElement(
          "div",
          { style: { fontSize: "12px", opacity: .7 } },
          "A self-extending plugin compiler: every blueprint compiles parameters into a ready-to-define dynamic Cordis plugin. Use the foundry_blueprints / foundry_scaffold / foundry_validate model tools to author and lint plugins, or call ctx.get('foundry').registerBlueprint(...) from any plugin to add a recipe."
        ),
        React.createElement(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "10px" } },
          blueprints.map(BlueprintCard)
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "foundry",
            order: 61,
            label: "Plugin Foundry",
          },
          FoundrySection
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
