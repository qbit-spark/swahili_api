const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const auth = require('../middleware/auth');
const enforceListingCap = require('../middleware/enforceListingCap');


/**
 * @swagger
 * components:
 *   schemas:
 *     Product:
 *       type: object
 *       required:
 *         - name
 *         - description
 *         - price
 *         - category
 *         - shop
 *       properties:
 *         name:
 *           type: string
 *           description: Product name
 *         description:
 *           type: string
 *           description: Product description
 *         price:
 *           type: number
 *           description: Product price
 *         images:
 *           type: array
 *           items:
 *             type: string
 *           description: Array of product image URLs
 *         category:
 *           type: string
 *           description: Category ID
 *         shop:
 *           type: string
 *           description: Shop ID
 *         stock:
 *           type: number
 *           description: Available stock quantity
 *         status:
 *           type: string
 *           enum: [active, inactive, outOfStock]
 *           description: Product status
 *         attributes:
 *           type: object
 *           description: Category-specific attributes
 *         ratings:
 *           type: object
 *           properties:
 *             average:
 *               type: number
 *             count:
 *               type: number
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * tags:
 *   name: Products
 *   description: Products management  endpoints
 */

router.get("/share/:id", productController.getProductSharePage);


/**
 * @swagger
 * /api/v1/products:
 *   get:
 *     tags:
 *       - Products
 *     summary: Get all products
 *     description: Retrieve products with pagination and filters
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Category ID
 *       - in: query
 *         name: shop
 *         schema:
 *           type: string
 *         description: Shop ID
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: number
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: number
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive, outOfStock]
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *     responses:
 *       200:
 *         description: List of products
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     products:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Product'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         current:
 *                           type: number
 *                         total:
 *                           type: number
 *                         totalRecords:
 *                           type: number
 *
 *   post:
 *     tags:
 *       - Products
 *     summary: Create new product
 *     security:
 *       - bearerAuth: []
 *     description: Create a new product (Seller only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       201:
 *         description: Product created successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Sellers only
 */
router.post('/', auth, enforceListingCap, productController.createProduct);

// Get all products (public route)
router.get('/', productController.getAllProducts);


/**
 * @swagger
 * /api/v1/products/{id}:
 *   get:
 *     tags:
 *       - Products
 *     summary: Get product by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product details
 *       404:
 *         description: Product not found
 *
 *   put:
 *     tags:
 *       - Products
 *     summary: Update product
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       200:
 *         description: Product updated successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Product owner only
 *       404:
 *         description: Product not found
 *
 *   delete:
 *     tags:
 *       - Products
 *     summary: Delete product
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Product owner only
 *       404:
 *         description: Product not found
 */
router.get('/:id', productController.getProductById);
    
// Update a product (protected route)
router.put('/:id', auth, productController.updateProduct);

// Delete a product (protected route)
router.delete('/:id', auth, productController.deleteProduct);


/**
 * @swagger
 * /api/v1/products/{id}/view:
 *   post:
 *     tags:
 *       - Products
 *     summary: Track product view
 *     description: Record a new view for the product
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID
 *     responses:
 *       200:
 *         description: View tracked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     views:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: number
 *                         unique:
 *                           type: number
 *       404:
 *         description: Product not found
 */
router.post('/:productId/view', productController.trackProductView);

/**
 * @swagger
 * /api/v1/products/{id}/views:
 *   get:
 *     tags:
 *       - Products
 *     summary: Get product view statistics
 *     description: Get total and unique views for a product
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Product ID
 *     responses:
 *       200:
 *         description: View statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     views:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: number
 *                         unique:
 *                           type: number
 *       404:
 *         description: Product not found
 */
router.get('/:productId/views', productController.getProductViewStats);

module.exports = router;