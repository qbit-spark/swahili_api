const Notification = require('../models/Notification');
const { Expo } = require('expo-server-sdk');

class NotificationService {
  constructor() {
    this.expo = new Expo();
  }

  async createPersistentNotification(recipientId, message, orderId) {
    return Notification.create({
      recipient: recipientId,
      message,
      relatedOrder: orderId,
      type: 'persistent'
    });
  }

  async sendPushNotification(pushToken, message, imageUrl = null) {
    if (!Expo.isExpoPushToken(pushToken)) {
      throw new Error('Invalid Expo push token');
    }

    const notificationContent = {
      to: pushToken,
      sound: 'default',
      body: message,
      data: { type: 'order_created' }
    };

    // Add image if provided
    if (imageUrl) {
      notificationContent.image = imageUrl;
    }

    const chunks = this.expo.chunkPushNotifications([notificationContent]);

    for (const chunk of chunks) {
      try {
        await this.expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        console.error('Error sending push notification:', error);
      }
    }
  }
}

module.exports = new NotificationService();
