const WithdrawalRequest = require('../models/WithdrawalRequest');
const Shop = require('../models/Shop');

exports.requestWithdrawal = async (req, res) => {
    try {
        const { amount, paymentDetails } = req.body;
        const userId = req.user._id;

        // Validate input
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                errors: ['Invalid amount']
            });
        }

        if (!paymentDetails || !paymentDetails.type || !paymentDetails.details) {
            return res.status(400).json({
                success: false,
                errors: ['Invalid payment details']
            });
        }

        // Find Shop owned by user
        const shop = await Shop.findOne({ owner: userId });
        if (!shop) {
            return res.status(404).json({
                success: false,
                errors: ['Shop not found for this user']
            });
        }

        // Validate balance
        // Ensure wallet exists (backward compatibility)
        if (!shop.wallet) {
            shop.wallet = { currentBalance: 0, lockedBalance: 0 };
        }

        if (shop.wallet.currentBalance < amount) {
            return res.status(400).json({
                success: false,
                errors: ['Insufficient funds']
            });
        }

        // Atomic transaction simulation (without actual mongo transactions for simplicity unless needed, but risk of race condition exists. Ideally use session transaction)
        // Decrement currentBalance, Increment lockedBalance
        shop.wallet.currentBalance -= amount;
        shop.wallet.lockedBalance += amount;
        await shop.save();

        // Create Request
        const withdrawal = new WithdrawalRequest({
            shop: shop._id,
            user: userId,
            amount,
            paymentDetails,
            status: 'pending'
        });

        await withdrawal.save();

        res.status(201).json({
            success: true,
            data: {
                withdrawal,
                wallet: shop.wallet
            }
        });

    } catch (error) {
        console.error('Withdrawal Request Error:', error);
        res.status(500).json({
            success: false,
            errors: ['Server error while processing withdrawal request']
        });
    }
};

exports.getWithdrawals = async (req, res) => {
    try {
        const { status, page = 1, limit = 10 } = req.query;
        const skip = (page - 1) * limit;

        let query = {};

        // If Admin, can see all (filter by status optional)
        // If Seller, can only see own shop's requests
        if (req.user.userType === 'ADMIN') {
            if (status) query.status = status;
        } else {
            const shop = await Shop.findOne({ owner: req.user._id });
            if (!shop) {
                return res.status(404).json({ success: false, errors: ['Shop not found'] });
            }
            query.shop = shop._id;
            if (status) query.status = status;
        }

        const withdrawals = await WithdrawalRequest.find(query)
            .populate('shop', 'name verificationStatus')
            .populate('user', 'username email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await WithdrawalRequest.countDocuments(query);

        res.json({
            success: true,
            data: {
                withdrawals,
                pagination: {
                    current: parseInt(page),
                    total: Math.ceil(total / limit),
                    totalRecords: total
                }
            }
        });

    } catch (error) {
        console.error('Get Withdrawals Error:', error);
        res.status(500).json({
            success: false,
            errors: ['Server error fetching withdrawals']
        });
    }
};

exports.updateWithdrawalStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNote } = req.body; // status: 'approved' or 'rejected'
        const adminId = req.user._id;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, errors: ['Invalid status'] });
        }

        const withdrawal = await WithdrawalRequest.findById(id);
        if (!withdrawal) {
            return res.status(404).json({ success: false, errors: ['Withdrawal request not found'] });
        }

        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ success: false, errors: ['Request is already processed'] });
        }

        const shop = await Shop.findById(withdrawal.shop);
        if (!shop) {
            return res.status(404).json({ success: false, errors: ['Associated shop not found'] });
        }

        if (status === 'approved') {
            // Funds already locked. Burn them (remove from lockedBalance).
            shop.wallet.lockedBalance -= withdrawal.amount;
            withdrawal.status = 'approved';
            withdrawal.processedBy = adminId;
            withdrawal.processedAt = new Date();
            withdrawal.adminNote = adminNote;

            await Promise.all([shop.save(), withdrawal.save()]);

        } else if (status === 'rejected') {
            // Refund the locked amount back to currentBalance
            shop.wallet.lockedBalance -= withdrawal.amount;
            shop.wallet.currentBalance += withdrawal.amount;

            withdrawal.status = 'rejected';
            withdrawal.processedBy = adminId;
            withdrawal.processedAt = new Date();
            withdrawal.adminNote = adminNote;

            await Promise.all([shop.save(), withdrawal.save()]);
        }

        res.json({
            success: true,
            data: {
                withdrawal,
                message: `Withdrawal ${status}`
            }
        });

    } catch (error) {
        console.error('Update Withdrawal Status Error:', error);
        res.status(500).json({
            success: false,
            errors: ['Server error updating withdrawal status']
        });
    }
};

exports.getWalletBalance = async (req, res) => {
    try {
        const userId = req.user._id;

        // Find the shop owned by this user
        // We only project the wallet field to keep the response lean
        const shop = await Shop.findOne({ owner: userId }).select('wallet');

        if (!shop) {
            return res.status(404).json({
                success: false,
                errors: ['Shop not found for this user']
            });
        }

        // Return the wallet data
        res.status(200).json({
            success: true,
            data: {
                wallet: shop.wallet
            }
        });

    } catch (error) {
        console.error('Get Wallet Balance Error:', error);
        res.status(500).json({
            success: false,
            errors: ['Server error while fetching wallet balance']
        });
    }
};
