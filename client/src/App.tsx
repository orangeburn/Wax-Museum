import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { CreatePage } from './pages/CreatePage';
import { DraftPage } from './pages/DraftPage';
import { GamePage } from './pages/GamePage';
import { FinalePage } from './pages/FinalePage';
import { ApiKeySettings } from './components/ApiKeySettings';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/create" element={<CreatePage />} />
      <Route path="/create/draft" element={<DraftPage />} />
      <Route path="/session/:sessionId" element={<GamePage />} />
      <Route path="/session/:sessionId/finale" element={<FinalePage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ApiKeySettings />
      <AppRoutes />
    </BrowserRouter>
  );
}
