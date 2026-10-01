import { useState } from 'react';
import {
  Alert,
  Badge,
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
  Tooltip,
  Typography,
  message,
} from 'antd';
import { LIFECYCLE_PHASE_LABEL, LIFECYCLE_REASON_LABEL, type LifecycleEventDto } from '@flil/shared';
import dayjs from 'dayjs';
import { useBackfillLifecycle, useLifecycleTrail } from '../api/hooks.js';
import { fmtDateTime } from '../lib/format.js';
import { useSession } from '../stores/session.js';

const PHASE_COLOR: Record<string, string> = {
  draft: 'default',
  lit: 'gold',
  scheduled: 'blue',
  archived: 'green',
  dropped: 'red',
};

function reasonText(code: string): string {
  return LIFECYCLE_REASON_LABEL[code] ?? code;
}

export function LifecycleTrail({ inspirationId }: { inspirationId: string }) {
  const tz = useSession((s) => s.libraryTz);
  const [order, setOrder] = useState<'seq' | 'event'>('seq');
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [form] = Form.useForm();
  const trail = useLifecycleTrail(inspirationId, order);
  const backfill = useBackfillLifecycle();

  const items = trail.data?.items ?? [];
  const integrity = trail.data?.integrity;

  async function submitBackfill() {
    const values = (await form.validateFields()) as {
      phase: string;
      reason: string;
      eventAt: dayjs.Dayjs;
    };
    try {
      await backfill.mutateAsync({
        id: inspirationId,
        phase: values.phase,
        reason: values.reason,
        eventAt: values.eventAt.toISOString(),
      });
      message.success('已补录（追加到审计链，未改动卡片当前状态）');
      setBackfillOpen(false);
      form.resetFields();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Card
      title="生命周期审计（草稿 / 布光 / 排期 / 归档 / 放弃）"
      extra={
        <Space>
          {integrity ? (
            integrity.ok ? (
              <Tooltip title="逐条重算 sha256 哈希链，未发现篡改">
                <Badge status="success" text="链完整" />
              </Tooltip>
            ) : (
              <Tooltip title={integrity.reason ?? ''}>
                <Badge status="error" text="链已断裂" />
              </Tooltip>
            )
          ) : null}
          <Button.Group>
            <Button size="small" type={order === 'seq' ? 'primary' : 'default'} onClick={() => setOrder('seq')}>
              落账先后
            </Button>
            <Button size="small" type={order === 'event' ? 'primary' : 'default'} onClick={() => setOrder('event')}>
              按发生时间
            </Button>
          </Button.Group>
          <Button size="small" onClick={() => setBackfillOpen(true)}>
            补录历史转变
          </Button>
        </Space>
      }
    >
      {integrity && !integrity.ok ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`审计链完整性校验失败：${integrity.reason ?? '未知原因'}`}
        />
      ) : null}
      {items.length === 0 ? (
        <Empty description="暂无生命周期记录" />
      ) : (
        <Timeline
          items={items.map((e: LifecycleEventDto) => ({
            color: e.kind === 'genesis' ? 'gray' : undefined,
            children: (
              <Space direction="vertical" size={2}>
                <Space wrap size={6}>
                  <Tag color={PHASE_COLOR[e.phase] ?? 'default'}>{e.phaseLabel}</Tag>
                  <Typography.Text strong>{reasonText(e.reason)}</Typography.Text>
                  {e.backfilled ? <Tag color="orange">补录</Tag> : null}
                  {e.kind === 'genesis' ? <Tag>起点</Tag> : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    #{e.seq}
                  </Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  发生：{fmtDateTime(e.eventAt, tz)}
                  {e.backfilled ? ` · 落账：${fmtDateTime(e.recordedAt, tz)}` : ''} · 责任人：
                  {e.actorRole === 'system' ? '系统（自动）' : e.actorName}
                </Typography.Text>
              </Space>
            ),
          }))}
        />
      )}

      <Modal
        open={backfillOpen}
        title="补录一次历史转变（只追加，不改当前状态）"
        onCancel={() => setBackfillOpen(false)}
        onOk={() => void submitBackfill()}
        confirmLoading={backfill.isPending}
        okText="补录"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="补录用于记录过去真实发生过、当时没来得及登记的转变。发生时间必须早于上一条记录；补录无法把活动卡改成归档/放弃。"
        />
        <Form form={form} layout="vertical" initialValues={{ phase: 'lit' }}>
          <Form.Item name="phase" label="当时进入的阶段" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'draft', label: LIFECYCLE_PHASE_LABEL.draft },
                { value: 'lit', label: LIFECYCLE_PHASE_LABEL.lit },
                { value: 'scheduled', label: LIFECYCLE_PHASE_LABEL.scheduled },
              ]}
            />
          </Form.Item>
          <Form.Item name="reason" label="原因" rules={[{ required: true, message: '请填写转变原因' }]}>
            <Input maxLength={200} placeholder="例如：断网那周实际出过境" />
          </Form.Item>
          <Form.Item name="eventAt" label="发生时间" rules={[{ required: true, message: '请选择发生时间' }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
