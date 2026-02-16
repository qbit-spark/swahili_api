require('dotenv').config();
const { default: ZenoPay } = require('zenopay');

class PaymentService {
  constructor() {
    this.zenoPay = new ZenoPay({
      accountID: process.env.ZENOPAY_ACCOUNT_ID,
      apiKey: process.env.ZENOPAY_API_KEY,
      secretKey: process.env.ZENOPAY_SECRET_KEY,
    });
  }

  async processPayment(orderDetails) {
    try {
      const paymentOptions = {
        amountToCharge: orderDetails.amounts.total,
        customerName: orderDetails.user.name,
        customerEmail: orderDetails.user.email,
        customerPhoneNumber: orderDetails.shippingAddress.phone,
        callbackURL: process.env.ZENOPAY_CALLBACK_URL,
      };
      const result = await this.zenoPay.Pay(paymentOptions);
      return result;
    } catch (error) {
      // console.log("An error occured while making payment:",error)
      throw new Error(`Payment processing failed: ${error.message}`);
    }
  }

  async checkPaymentStatus(orderId) {
    try {
      const result = await this.zenoPay.CheckPaymentStatus(orderId);
      return result;
    } catch (error) {
      throw new Error(`Payment status check failed: ${error.message}`);
    }
  }
  
}

module.exports = new PaymentService();