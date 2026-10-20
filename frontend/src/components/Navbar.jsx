import { Activity, LayoutDashboard, Mic2 } from "lucide-react";
import { NavLink } from "react-router-dom";

function NavItem({ to, icon: Icon, children }) {
  return (
    <NavLink className={({ isActive }) => "nav-link" + (isActive ? " is-active" : "")} to={to} end={to === "/"}>
      <Icon aria-hidden="true" size={16} />
      <span>{children}</span>
    </NavLink>
  );
}

export default function Navbar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <NavLink className="brand" to="/" aria-label="AURALYTIX AI home">
          <span className="brand-mark" aria-hidden="true"><Activity size={19} /></span>
          <span className="brand-wordmark">AURALYTIX<span>AI</span></span>
        </NavLink>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavItem to="/" icon={LayoutDashboard}>Research desk</NavItem>
          <NavItem to="/voice" icon={Mic2}>Voice input</NavItem>
        </nav>
        <div className="topbar-caption">MULTI-SOURCE ANALYSIS</div>
      </div>
    </header>
  );
}
