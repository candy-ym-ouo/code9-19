import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, DatePicker, Select, Space, Table, Tag, Typography } from 'antd';
import type { LifecycleEventDto } from '@flil/shared';
import dayjs from 'dayjs';
import { get } from '../api/client.js';
import { useLifecycleEvents } from '../api/hooks.js';
import { fmtDateTime } from '../lib/format.js';
import { useSession } from '../stores/session.js';

const PHASE_COLOR: Record<string, string> = {
  draft: 'default',
  lit: 'gold',
  scheduled: 'blue',
  archived: 'green',
  dropped: 'red',
};

const RANGE_PRESETS: { label: string; days: number | null }[] = [
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
  { label: '全部', days: null },
];

export default function LifecycleAudit() {
  const tz = useSession((s) => s.libraryTz);
  const [days, setDays] = useState<number | null>(30);
  const [custom, setCustom] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
  const [phase, setPhase] = useState<string | undefined>();
  const [backfilledOnly, setBackfilledOnly] = useState(false);
  const [integrity, setIntegrity] = useState<{ ok: boolean; checked: number; reason: string | null } | null>(null);

  const params: Record<string, string | number | undefined> = {};
  if (custom) {
    params.from = custom[0].toISOString();
    params.to = custom[1].toISOString();
  } else if (days !== null) {
    params.from = dayjs().subtract(days, 'day').toISOString();
  }
  if (phase) params.phase = phase;
  if (backfilledOnly) params.backfilled = 'true';
  params.sort = 'event';

  const events = useLifecycleEvents(params);

  async function verify() {
    const res = await get<{ ok: boolean; checked: number; reason: string | null }>('/lifecycle/verify');
    setIntegrity(res);
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="生命周期审计回溯"
        extra={
          <Space>
            {integrity ? (
              integrity.ok ? (
                <Badge status="success" text={`哈希链完整（${integrity.checked} 条）`} />
              ) : (
                <Badge status="error" text={`校验失败：${integrity.reason ?? ''}`} />
              )
            ) : null}
            <Button size="small" onClick={() => void verify()}>
              校验全库哈希链
            </Button>
          </Space>
        }
      >
        <Space wrap>
          <Space.Compact>
            {RANGE_PRESETS.map((p) => (
              <Button
                key={p.label}
                size="small"
                type={!custom && days === p.days ? 'primary' : 'default'}
                onClick={() => {
                  setDays(p.days);
                  setCustom(null);
                }}
              >
                {p.label}
              </Button>
            ))}
          </Space.Compact>
          <DatePicker.RangePicker
            showTime
            size="small"
            value={custom}
            onChange={(v) => setCustom(v as [dayjs.Dayjs, dayjs.Dayjs] | null)}
          />
          <Select
            size="small"
            allowClear
            placeholder="阶段"
            style={{ width: 130 }}
            value={phase}
            onChange={setPhase}
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'lit', label: '布光' },
              { value: 'scheduled', label: '排期' },
              { value: 'archived', label: '归档' },
              { value: 'dropped', label: '放弃' },
            ]}
          />
          <Button
            size="small"
            type={backfilledOnly ? 'primary' : 'default'}
            onClick={() => setBackfilledOnly((v) => !v)}
          >
            只看补录
          </Button>
        </Space>
      </Card>

      <Card>
        <Table<LifecycleEventDto>
          rowKey="id"
          size="small"
          loading={events.isLoading}
          dataSource={events.data?.items ?? []}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          columns={[
            {
              title: '发生时间',
              dataIndex: 'eventAt',
              width: 150,
              sorter: (a, b) => new Date(a.eventAt).getTime() - new Date(b.eventAt).getTime(),
              defaultSortOrder: 'descend',
              render: (v: string) => fmtDateTime(v, tz),
            },
            {
              title: '阶段',
              dataIndex: 'phase',
              width: 90,
              render: (phase: string, r) => (
                <Space size={4}>
                  <Tag color={PHASE_COLOR[phase] ?? 'default'}>{r.phaseLabel}</Tag>
                  {r.backfilled ? <Tag color="orange">补录</Tag> : null}
                </Space>
              ),
            },
            { title: '原因', dataIndex: 'reason', width: 130 },
            {
              title: '责任人',
              width: 140,
              render: (_, r) =>
                r.actorRole === 'system' ? (
                  <Typography.Text type="secondary">系统（自动）</Typography.Text>
                ) : (
                  r.actorName
                ),
            },
            {
              title: '灵感卡',
              dataIndex: 'inspirationId',
              render: (id: string) => <Link to={`/inspirations/${id}`}>{id.slice(0, 10)}…</Link>,
            },
            {
              title: '落账时间',
              dataIndex: 'recordedAt',
              width: 150,
              render: (v: string) => fmtDateTime(v, tz),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
