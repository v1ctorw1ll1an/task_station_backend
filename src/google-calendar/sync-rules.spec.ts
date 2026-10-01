import {
  decideRemoteChange,
  isWritableAccessRole,
  nextRetryDelayMs,
  RemoteChangeInput,
  shouldPush,
} from './sync-rules';

const t = (iso: string) => new Date(iso);

function input(over: Partial<RemoteChangeInput> = {}): RemoteChangeInput {
  return {
    remoteEtag: '"2"',
    linkEtag: '"1"',
    frozen: false,
    readOnly: false,
    localUpdatedAt: t('2026-10-01T10:00:00Z'),
    linkLocalUpdatedAt: t('2026-10-01T10:00:00Z'),
    remoteUpdated: t('2026-10-01T11:00:00Z'),
    ...over,
  };
}

describe('sync-rules (google-calendar)', () => {
  describe('decideRemoteChange', () => {
    it('mesmo etag do último push = eco, ignora', () => {
      expect(decideRemoteChange(input({ remoteEtag: '"1"' }))).toBe('echo');
    });

    it('eco vence até congelamento/somente-leitura (nada mudou de fato)', () => {
      expect(decideRemoteChange(input({ remoteEtag: '"1"', frozen: true, readOnly: true }))).toBe(
        'echo',
      );
    });

    it('empresa congelada: ignora a edição remota', () => {
      expect(decideRemoteChange(input({ frozen: true }))).toBe('ignore_frozen');
    });

    it('cópia somente-leitura: reverte', () => {
      expect(decideRemoteChange(input({ readOnly: true }))).toBe('revert');
    });

    it('só o Google mudou: aplica', () => {
      expect(decideRemoteChange(input())).toBe('apply_remote');
    });

    it('os dois mudaram e o TaskDY por último: mantém o local', () => {
      expect(
        decideRemoteChange(
          input({
            localUpdatedAt: t('2026-10-01T12:00:00Z'),
            remoteUpdated: t('2026-10-01T11:00:00Z'),
          }),
        ),
      ).toBe('push_local');
    });

    it('os dois mudaram e o Google por último: aplica', () => {
      expect(
        decideRemoteChange(
          input({
            localUpdatedAt: t('2026-10-01T10:30:00Z'),
            remoteUpdated: t('2026-10-01T11:00:00Z'),
          }),
        ),
      ).toBe('apply_remote');
    });

    it('reatar (sem histórico): decide só pela última edição', () => {
      expect(
        decideRemoteChange(
          input({
            linkEtag: null,
            linkLocalUpdatedAt: null,
            localUpdatedAt: t('2026-10-02T00:00:00Z'),
          }),
        ),
      ).toBe('push_local');
      expect(
        decideRemoteChange(
          input({
            linkEtag: null,
            linkLocalUpdatedAt: null,
            localUpdatedAt: t('2026-09-01T00:00:00Z'),
          }),
        ),
      ).toBe('apply_remote');
    });
  });

  describe('shouldPush', () => {
    const base = {
      force: false,
      hasLink: true,
      localUpdatedAt: t('2026-10-01T10:00:00Z'),
      linkLocalUpdatedAt: t('2026-10-01T10:00:00Z'),
      linkReadOnly: false,
      readOnly: false,
    };

    it('sem mudança local desde o último push: não manda (supressão de eco)', () => {
      expect(shouldPush(base)).toBe(false);
    });

    it('mudança local posterior: manda', () => {
      expect(shouldPush({ ...base, localUpdatedAt: t('2026-10-01T10:00:01Z') })).toBe(true);
    });

    it('sem link, forçado ou permissão mudou: manda', () => {
      expect(shouldPush({ ...base, hasLink: false })).toBe(true);
      expect(shouldPush({ ...base, force: true })).toBe(true);
      expect(shouldPush({ ...base, readOnly: true })).toBe(true);
    });
  });

  it('isWritableAccessRole', () => {
    expect(isWritableAccessRole('owner')).toBe(true);
    expect(isWritableAccessRole('writer')).toBe(true);
    expect(isWritableAccessRole('reader')).toBe(false);
    expect(isWritableAccessRole('freeBusyReader')).toBe(false);
    expect(isWritableAccessRole(undefined)).toBe(false);
  });

  it('nextRetryDelayMs: exponencial com teto de 1 h', () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(120_000);
    expect(nextRetryDelayMs(3)).toBe(240_000);
    expect(nextRetryDelayMs(20)).toBe(3_600_000);
  });
});
