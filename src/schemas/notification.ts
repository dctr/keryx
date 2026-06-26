import notificationSchema from '../../schemas/notification.v1.schema.json';

import { createValidator } from './validate';

export interface Notification {
  schema: 'keryx.notification.v1';
  channel: 'interrupt' | 'digest';
  target: string;
  sent_at: string;
  dedupe_key: string;
}

export { notificationSchema };
export const validateNotification = createValidator<Notification>(notificationSchema);
