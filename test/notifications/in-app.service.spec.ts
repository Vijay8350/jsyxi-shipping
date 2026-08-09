import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { InAppService } from '../../src/modules/notifications/in-app.service';
import { IN_APP_EVENT } from '../../src/modules/notifications/notifications.types';
import { OWNER, SHOP, routedQuery } from './helpers';

/**
 * The in-app inbox convention (briefed DECISION): message_log rows with
 * event = 'in_app', provider_ref = the member uuid; the text lives on the
 * referenced message_template row. Members see only their own rows.
 */
describe('InAppService (in-app inbox as message_log rows)', () => {
  it('writeInApp stores the text on a template row and the inbox row DELIVERED', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const query = routedQuery([
      [
        'INSERT INTO message_template',
        (_sql: string, params: unknown[]) => {
          writes.push({ sql: _sql, params });
          return { rows: [{ template_id: 'tpl-1' }] };
        },
      ],
      [
        'INSERT INTO message_log',
        (_sql: string, params: unknown[]) => {
          writes.push({ sql: _sql, params });
          return { rows: [{ message_id: 'msg-1' }] };
        },
      ],
    ]);
    const service = new InAppService({ query } as unknown as Pool);

    const id = await service.writeInApp(SHOP, OWNER, {
      subject: 'Courier disconnected',
      body: 'Delhivery credentials failed',
    });

    expect(id).toBe('msg-1');
    const template = writes[0];
    expect(template.params[1]).toBe(IN_APP_EVENT);
    expect(String(template.params[2])).toContain('Courier disconnected');
    const log = writes[1];
    expect(log.params[1]).toBe(IN_APP_EVENT);
    expect(log.params[5]).toBe(OWNER); // provider_ref = member uuid
    expect(log.sql).toContain(`'DELIVERED'`);
  });

  it('listInApp reads only the calling member rows, newest first', async () => {
    const query = routedQuery([
      [
        'FROM message_log',
        () => ({
          rows: [
            {
              message_id: 'msg-2',
              body: 'A\n\nB',
              queued_at: '2026-08-05T10:00:00Z',
              read_at: null,
            },
          ],
        }),
      ],
    ]);
    const service = new InAppService({ query } as unknown as Pool);

    const items = await service.listInApp(SHOP, OWNER);
    expect(items).toHaveLength(1);
    expect(items[0].messageId).toBe('msg-2');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([SHOP, IN_APP_EVENT, OWNER, 50]);
    expect(sql).toContain('provider_ref = $3');
  });

  it('markRead only touches the member own DELIVERED row', async () => {
    const query = routedQuery([
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
    ]);
    const service = new InAppService({ query } as unknown as Pool);

    expect(await service.markRead(SHOP, OWNER, 'msg-1')).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([SHOP, 'msg-1', IN_APP_EVENT, OWNER]);
    expect(sql).toContain(`state = 'READ'`);
    expect(sql).toContain(`state = 'DELIVERED'`); // only unread rows transition
  });
});
