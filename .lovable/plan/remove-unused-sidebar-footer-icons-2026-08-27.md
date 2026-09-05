Remove unused sidebar footer icons

- In `src/components/app-shell.tsx`, remove the Settings, HelpCircle, and User icon buttons from the sidebar footer button list, leaving only Sign out.
- Remove the now-unused `Settings`, `HelpCircle`, and `User` imports from the lucide-react import block.
- Keep the existing expanded/collapsed layout, hover states, and sign-out behavior unchanged.
- Run the TypeScript check after the edit.