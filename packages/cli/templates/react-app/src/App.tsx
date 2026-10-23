import { __COMPONENT_NAME__ } from "./audiospan/__COMPONENT_NAME__.tsx";

export function App() {
  return (
    <main>
      <h1>__PLUGIN_NAME__</h1>
      <p>
        The plugin is built from <code>__PLUGIN_DIR__</code> into <code>public/plugins/__PROJECT_NAME__/</code> by <code>npm run plugin</code>; the component below loads it with the hooks from
        <code>@audiospan/react</code>.
      </p>
      <__COMPONENT_NAME__ />
    </main>
  );
}
