import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { AgentBar } from "./components/AgentBar";
import { ConnectsBadge } from "./components/ConnectsBadge";
import { Queue } from "./pages/Queue";
import { ProposalDetail } from "./pages/ProposalDetail";
import { Niches } from "./pages/Niches";
import { Clicks } from "./pages/Clicks";
import { Templates } from "./pages/Templates";

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Outreach Agent</h1>
        <nav>
          <NavLink to="/templates" className={({ isActive }) => isActive ? "active" : ""}>Templates</NavLink>
          <NavLink to="/queue" className={({ isActive }) => isActive ? "active" : ""}>Queue</NavLink>
          <NavLink to="/niches" className={({ isActive }) => isActive ? "active" : ""}>Niches</NavLink>
          <NavLink to="/clicks" className={({ isActive }) => isActive ? "active" : ""}>Clicks</NavLink>
        </nav>
        <ConnectsBadge />
        <AgentBar />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/queue" replace />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/proposals/:jobId" element={<ProposalDetail />} />
          <Route path="/niches" element={<Niches />} />
          <Route path="/clicks" element={<Clicks />} />
        </Routes>
      </main>
    </div>
  );
}
