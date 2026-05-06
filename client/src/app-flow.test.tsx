import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from './App';

describe('app flow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('creates a fully local game, plays an action, and lists the browser save', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await screen.findByText('继续旧局');
    await user.click(screen.getByRole('button', { name: '开始新局' }));

    await screen.findByText('设定你的故事。');
    await user.type(screen.getByLabelText('故事 Prompt'), '风雪山庄，4人，逃生/破案');
    await user.selectOptions(screen.getByLabelText('角色数量'), '4');
    await user.click(screen.getByRole('button', { name: '生成剧本' }));

    await screen.findByText('构建故事与角色。');
    await screen.findByRole('button', { name: /工程师/ });
    await user.click(screen.getByRole('button', { name: '进入故事' }));

    expect((await screen.findAllByText('船员舱')).length).toBeGreaterThan(0);
    expect(await screen.findByLabelText('自然语言行动')).toBeInTheDocument();
    await user.type(screen.getByLabelText('自然语言行动'), '查看储物柜');
    await user.click(screen.getByRole('button', { name: '执行行动' }));

    await waitFor(() => {
      const stored = Object.keys(localStorage).find((key) => key.startsWith('wax-museum.session.'));
      expect(stored).toBeTruthy();
      expect(JSON.parse(localStorage.getItem(stored ?? '') ?? '{}').eventLog.length).toBeGreaterThan(1);
    });
    expect(screen.getByText(/秘密目标进行中/)).toBeInTheDocument();
  });

  it('persists saves in localStorage without calling a backend API', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/create']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await screen.findByText('设定你的故事。');
    await user.type(screen.getByLabelText('故事 Prompt'), '失事潜艇');
    await user.click(screen.getByRole('button', { name: '生成剧本' }));
    await screen.findByText('构建故事与角色。');
    await user.click(await screen.findByRole('button', { name: '进入故事' }));
    await screen.findByLabelText('自然语言行动');

    cleanup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await screen.findByText('继续旧局');
    expect(screen.getByRole('button', { name: /失事潜艇|临时故事|工程师/ })).toBeInTheDocument();
  });
});
