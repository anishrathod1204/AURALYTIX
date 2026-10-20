import { createBrowserRouter, RouterProvider } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Voice from "./pages/Voice";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import Terms from "./pages/Terms";

const router = createBrowserRouter([
  { path: "/", element: <Dashboard /> },
  { path: "/voice", element: <Voice /> },
  { path: "/privacy", element: <PrivacyPolicy /> },
  { path: "/terms", element: <Terms /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
