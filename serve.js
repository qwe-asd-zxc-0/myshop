const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = 3000;

// --- 1. 配置上传与静态资源 ---

// 确保 public/uploads 目录存在 (用于存图片)
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置 Multer 存储策略 (文件名防重)
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });

// --- 2. 中间件配置 ---
app.use(cors());
app.use(bodyParser.json());

// 【关键修改】配置静态文件服务
// 1. 让 /uploads/... 可以访问图片
app.use(express.static(path.join(__dirname, 'public')));
// 2. 让根目录下的 .html 文件 (如 个人中心.html) 可以直接访问
app.use(express.static(__dirname));


// --- 3. 数据库初始化 ---
const db = new sqlite3.Database('./gci.db', (err) => {
    if (err) console.error('数据库连接失败:', err.message);
    else console.log('已连接到 SQLite 数据库 (gci.db)');
});

db.serialize(() => {
    // 初始化商品表
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand TEXT, name TEXT, origin TEXT, type TEXT, tar TEXT, price TEXT, stock INTEGER, image TEXT
    )`, (err) => {
        // 尝试添加 image 列 (防止旧表缺少此字段)
        if (!err) db.run("ALTER TABLE products ADD COLUMN image TEXT", () => {});
    });

    // 初始化用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`);
    // 插入默认管理员 (如果不存在)
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', '123', 'admin')`);
});

// --- 4. API 接口编写 ---

// [GET] 获取商品列表
app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [POST] 新增商品 (支持图片)
app.post('/api/products', upload.single('image'), (req, res) => {
    const { brand, name, origin, type, tar, price, stock } = req.body;
    const imagePath = req.file ? `/uploads/${req.file.filename}` : ''; // 保存相对路径
    
    const sql = `INSERT INTO products (brand, name, origin, type, tar, price, stock, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [brand, name, origin, type, tar, price, stock, imagePath];

    db.run(sql, params, function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ message: "添加成功", id: this.lastID });
    });
});

// [PUT] 修改商品 (支持更新图片)
app.put('/api/products/:id', upload.single('image'), (req, res) => {
    const { brand, name, origin, type, tar, price, stock } = req.body;
    let sql, params;
    
    if (req.file) {
        // 如果上传了新图，更新 image 字段
        const imagePath = `/uploads/${req.file.filename}`;
        sql = `UPDATE products SET brand=?, name=?, origin=?, type=?, tar=?, price=?, stock=?, image=? WHERE id=?`;
        params = [brand, name, origin, type, tar, price, stock, imagePath, req.params.id];
    } else {
        // 没传新图，保持原样
        sql = `UPDATE products SET brand=?, name=?, origin=?, type=?, tar=?, price=?, stock=? WHERE id=?`;
        params = [brand, name, origin, type, tar, price, stock, req.params.id];
    }

    db.run(sql, params, function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ message: "更新成功" });
    });
});

// [DELETE] 删除商品
app.delete('/api/products/:id', (req, res) => {
    db.run(`DELETE FROM products WHERE id = ?`, req.params.id, function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ message: "删除成功" });
    });
});

// --- 用户管理接口 ---

// [GET] 获取用户列表 (仅返回必要字段)
app.get('/api/users', (req, res) => {
    db.all("SELECT id, username, role FROM users ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [POST] 用户登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            res.json({ message: "登录成功", user: { username: row.username, role: row.role } });
        } else {
            res.status(401).json({ error: "账号或密码错误" });
        }
    });
});

// [POST] 用户注册
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "用户名和密码不能为空" });
    
    // 默认为普通用户
    const role = 'user'; 
    const sql = `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`;
    
    db.run(sql, [username, password, role], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: "该用户名已被注册" });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: "注册成功", user: { username, role } });
    });
});

// [POST] 修改密码
app.post('/api/change-password', (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    
    // 1. 验证旧密码
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, oldPassword], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(401).json({ error: "旧密码不正确" });

        // 2. 更新新密码
        db.run("UPDATE users SET password = ? WHERE id = ?", [newPassword, row.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "密码修改成功" });
        });
    });
});

// --- 5. 启动服务器 ---
app.listen(PORT, () => {
    console.log(`---------------------------------------`);
    console.log(`服务器运行中: http://localhost:${PORT}`);
    console.log(`请在浏览器访问: http://localhost:${PORT}/主页面.html`);
    console.log(`---------------------------------------`);
});