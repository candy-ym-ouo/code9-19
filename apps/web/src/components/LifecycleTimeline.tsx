import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { LIFECYCLE_SOURCE_LABEL, type InspirationStatus } from '@flil/shared';
import { useBackfillLifecycle, useLifecycle } from '../api/hooks.js';
import { STATUS_META, fmtDateTime } from '../lib/format.js';

const STATUS_OPTIONS = (Object.keys(STATUS_META) as InspirationStatus[]).map((s) => ({
  value: s,
  label: STATUS_META[s].label,
}));

interface BackfillFormValues {
  toStatus: InspirationStatus;
  fromStatus?: InspirationStatus | null;
  occurredAt: Dayjs;
  reason: string;
}

/**
 * 生命周期台账时间线。
 * 排序权威是追加序（seq）：补录记录出现在它实际落库的位置，并标注"补录于 …"，
 * 历史里已存在的记录永远不会被它顶下去。
 */
export function LifecycleTimeline({
  inspirationId,
  tz,
  revision,
}: {
  inspirationId: string;
  tz: string;
  revision?: string;
}) {
  const lifecycle = useLifecycle(inspirationId, revision);
  const backfill = useBackfillLifecycle();
  const [actorId, setActorId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<BackfillFormValues>();

  const items = useMemo(() => lifecycle.data?.items ?? [], [lifecycle.data]);
  const actorOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of items) if (e.actorId) seen.set(e.actorId, e.actorName);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);
  const filtered = actorId ? items.filter((e) => e.actorId === actorId) : items;

  async function submit() {
    const values = await form.validateFields();
    try {
      await backfill.mutateAsync({
        id: inspirationId,
        toStatus: values.toStatus,
        fromStatus: values.fromStatus ?? null,
        occurredAt: values.occurredAt.toISOString(),
        reason: values.reason,
      });
      message.success('已补录：只追加到台账末尾，不改变卡片当前状态');
      setOpen(false);
      form.resetFields();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Card
      title="生命周期（每次转变都有台账）"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按责任人筛选"
            style={{ width: 150 }}
            options={actorOptions}
            value={actorId}
            onChange={(v) => setActorId(v ?? null)}
          />
          <Button size="small" onClick={() => setOpen(true)}>
            补录
          </Button>
        </Space>
      }
    >
      {filtered.length === 0 ? (
        <Empty description="暂无记录" />
      ) : (
        <Timeline
          items={filtered.map((e) => ({
            color:
              e.source === 'backfill'
                ? 'orange'
                : e.toStatus === 'archived' || e.toStatus === 'dropped'
                  ? 'gray'
                  : 'blue',
            children: (
              <Space direction="vertical" size={2}>
                <Space wrap size={6}>
                  {e.fromStatus ? <Tag>{STATUS_META[e.fromStatus].label}</Tag> : <Tag>创建</Tag>}
                  <span>→</span>
                  <Tag color={STATUS_META[e.toStatus].color}>{STATUS_META[e.toStatus].label}</Tag>
                  <Typography.Text type="secondary">{e.actorName}</Typography.Text>
                  {e.source !== 'user' ? (
                    <Tag color={e.source === 'backfill' ? 'orange' : 'default'}>
                      {LIFECYCLE_SOURCE_LABEL[e.source]}
                    </Tag>
                  ) : null}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  发生于 {fmtDateTime(e.occurredAt, tz)}
                  {e.source === 'backfill' ? ` · 补录于 ${fmtDateTime(e.recordedAt, tz)}` : ''}
                </Typography.Text>
                {e.reason ? <Typography.Text style={{ fontSize: 12 }}>{e.reason}</Typography.Text> : null}
              </Space>
            ),
          }))}
        />
      )}
      <Modal
        open={open}
        title="补录历史转变"
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="补录"
        confirmLoading={backfill.isPending}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="补录只追加到台账末尾：历史顺序不会被插入或改写，卡片当前状态也不变。"
        />
        <Form form={form} layout="vertical">
          <Form.Item name="toStatus" label="当时到达的状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={STATUS_OPTIONS} placeholder="选择状态" />
          </Form.Item>
          <Form.Item name="fromStatus" label="前置状态（留空则按台账自动推断）">
            <Select allowClear options={STATUS_OPTIONS} placeholder="自动推断" />
          </Form.Item>
          <Form.Item name="occurredAt" label="实际发生时间" rules={[{ required: true, message: '请选择时间' }]}>
            <DatePicker showTime style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item name="reason" label="补录原因" rules={[{ required: true, message: '补录必须填写原因' }]}>
            <Input.TextArea rows={2} maxLength={500} placeholder="例如：上周在外拍摄，回来补登排期" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
