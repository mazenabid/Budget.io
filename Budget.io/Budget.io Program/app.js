const express = require("express");
const app = express();
const port = 3000;
const mongoose = require("mongoose");
const session = require("express-session");
const passport = require("passport");
const passportLocalMongoose = require("passport-local-mongoose");
require("dotenv").config();

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

app.use(express.static("public"));
app.use(express.json());
app.use('/img', express.static(__dirname + '/views/img'));
app.use(express.urlencoded({ extended: true })); 
app.set("view engine", "ejs");

app.use(session({
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

mongoose.connect("mongodb://localhost:27017/project");

const userSchema = new mongoose.Schema({
    username: String,
    password: String
});
userSchema.plugin(passportLocalMongoose);
const User = new mongoose.model("User", userSchema);

const transactionSchema = new mongoose.Schema({
    username: {
        type: mongoose.Schema.Types.String,
        ref: 'User'
    },
    f_ins: String,
    product: String,
    price: Number,
    date: Date,
    category: String
});
const Transaction = new mongoose.model("Transaction", transactionSchema);

const budgetSchema = new mongoose.Schema({
    username: { type: String, required: true },
    type: String,
    amount: Number,
    a_used: { type: Number, default: 0 },
    a_left: Number,
    month: Number, // 1-12 for January-December
    year: Number
});

// Pre-save hook to calculate 'a_left' before saving the document
budgetSchema.pre('save', function(next) {
    this.a_left = this.amount - this.a_used;
    next();
});

const Budget = new mongoose.model("Budget", budgetSchema);

const incomeSchema = new mongoose.Schema({
    username: { type: String, required: true },
    amount: Number,
    month: Number,
    year: Number,
    a_used: { type: Number, default: 0 },
    a_left: Number
});

const Income = new mongoose.model("Income", incomeSchema);

passport.use(User.createStrategy());
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.get("/", function(req, res){
    res.render("index");
});

app.post('/login', function(req, res, next) {
    passport.authenticate('local', function(err, user, info) {
      if (err) { return next(err); }
      if (!user) { return res.redirect('/'); }
      req.logIn(user, function(err) {
        if (err) { return next(err); }
        req.session.email = req.body.username;
        return res.redirect(307, "/todo");
      });
    })(req, res, next);
});

app.post("/register", async function(req, res) {
    try {
        const existingUser = await User.findOne({ username: req.body.username });
        if (existingUser) {
            // User with this username already exists
            console.log("User with this username already exists.");
            return res.redirect("/"); // Redirect to the registration page or an error page
        }

        // If no existing user, proceed with registration
        const newUser = new User({ username: req.body.username });
        const registeredUser = await User.register(newUser, req.body.password);
        
        passport.authenticate("local")(req, res, function(){
            req.session.email = req.body.username;
            res.redirect(307, "/todo");
        });

    } catch (err) {
        console.log(err);
        res.redirect("/");
    }
});

app.post('/todo', async function(req, res) {
    var email = req.session.email;

    try {
        const transactionDocs = await Transaction.find({ username: email }).sort({ date: -1 }).lean().exec();
        const budgets = await Budget.find({ username: email });
        const monthlyIncomes = await Income.find({ username: email });
        const fInsTotals = await getFInsTotals(email);

        let enhancedIncomes = await Promise.all(monthlyIncomes.map(async (income) => {
            let relatedBudgets = await Budget.find({ 
                month: income.month, 
                year: income.year,
                username: email
            }).lean().exec();
            return {
                ...income.toObject(),
                relatedBudgets: relatedBudgets || []
            };
        }));
    
        res.render('budget', { 
            email, 
            transactions: transactionDocs,
            budgets,
            monthlyIncomes: enhancedIncomes,
            fInsTotals,
            activeTab: 'goal-tracking'
        });
    } catch (error) {
        console.error("Error in rendering todo list: ", error);
        res.redirect("/");
    }
});


app.post('/add-transaction', async (req, res) => {
    const { username, f_ins, product, price, date, category } = req.body;

    try {
        var email = req.session.email;
        
        // Check if the budget category exists
        const categoryTrimmed = category.trim();
        const budgetExists = await Budget.findOne({ type: categoryTrimmed });
        console.log("Searching for budget category:", categoryTrimmed);
        console.log("Budget found:", budgetExists);
        console.log("Received transaction data:", req.body);

        if (!budgetExists) {
            console.error("Transaction denied: Budget category does not exist");
            // Deny the request and send back a JSON response with an error message
            return res.status(404).send('Budget category not found');
        }

        const transactionDate = new Date(date);
        // Since the budget category exists, proceed with transaction creation
        const newTransaction = new Transaction({ username, f_ins, product, price, date: transactionDate, category });
        await newTransaction.save();
        

        // Update the budget with this transaction
        await updateBudgetOnTransaction(category, price, transactionDate);
        await updateIncomeWithBudgetUsage();

        // Fetch updated list of transactions
        const transactions = await Transaction.find({ username }).sort({ date: -1 }).lean().exec();
        const budgets = await Budget.find();
        const monthlyIncomes = await Income.find();
        const fInsTotals = await getFInsTotals(email);
        

        let enhancedIncomes = await enhanceIncomesWithRelatedBudgets(monthlyIncomes, budgets);

        // Render the page with updated transactions
        res.render('budget', { 
            budgets: budgets,
            email,
            transactions,
            monthlyIncomes: enhancedIncomes,
            fInsTotals,
            activeTab: 'transactions'
        });
    } catch (error) {
        console.error("Error adding transaction: ", error);
        // Send back a JSON response with an error flag/message for server errors
        res.status(500).json({ success: false, message: "Error processing transaction" });
    }
});

// Delete a transaction
app.post('/delete-transaction', async (req, res) => {
    try {
        const transactionId = req.body.transaction_id;

        if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
            return res.status(400).send('Invalid transaction ID');
        }

        // Fetch the transaction before deleting
        const transaction = await Transaction.findById(transactionId);
        if (!transaction) {
            return res.status(404).send('Transaction not found');
        }

        // Get the email from the session
        var email = req.session.email; // Moved this line inside the try block

        // Update the budget
        await revertBudgetOnTransactionDeletion(transaction.category, transaction.price);

        const monthlyIncomes = await Income.find();

        // Delete the transaction
        await Transaction.findByIdAndDelete(transactionId);

        const transactions = await Transaction.find({ username: email }).sort({ date: -1 }).lean().exec();
        const budgets = await Budget.find();
        const fInsTotals = await getFInsTotals(email);
        let enhancedIncomes = await enhanceIncomesWithRelatedBudgets(monthlyIncomes, budgets);

        res.render('budget', { 
            budgets: budgets,
            email: email,
            transactions,
            monthlyIncomes: enhancedIncomes,
            fInsTotals,
            activeTab: 'transactions'
        });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).send('Error deleting transaction');
    }
});

async function getFInsTotals(username) {
    try {
        // Aggregate transactions by f_ins and sum up the prices
        return await Transaction.aggregate([
            { $match: { username: username } },
            { $group: { _id: "$f_ins", totalAmount: { $sum: "$price" } } }
        ]);
    } catch (error) {
        console.error("Error aggregating f_ins totals: ", error);
        return []; // Return an empty array in case of an error
    }
}

async function revertBudgetOnTransactionDeletion(category, transactionPrice) {
    try {
        const price = parseFloat(transactionPrice);
        let budget = await Budget.findOne({ type: category });

        if (budget) {
            // Reduce the amount used in the budget
            budget.a_used -= price;
            budget.a_left = budget.amount - budget.a_used;
            await budget.save();

            // Recalculate the total amount used from all budgets
            const totalUsedFromBudgets = (await Budget.find()).reduce((sum, budget) => sum + budget.a_used, 0);

            // Fetch all income records
            const incomes = await Income.find();

            // Update each income record based on the new total used amount
            for (let income of incomes) {
                income.a_used = totalUsedFromBudgets;
                income.a_left = income.amount - totalUsedFromBudgets;
                await income.save();
            }
        }
    } catch (error) {
        console.error("Error reverting budget on transaction deletion: ", error);
        throw error;
    }
}

app.get('/add', (req, res) => {
    res.render('add'); // This assumes 'add.ejs' is in your views folder
});

app.post('/add-budget', async (req, res) => {
    const { type, amount, month, year } = req.body;
    var email = req.session.email;

    try {
        // Ensure month and year are integers
        const monthInt = parseInt(month, 10);
        const yearInt = parseInt(year, 10);

        // Validate the month and year
        if (monthInt < 1 || monthInt > 12 || yearInt < 1900 || yearInt > new Date().getFullYear()) {
            return res.status(400).send("Invalid month or year");
        }

        const newBudget = new Budget({ 
            username: email,
            type, 
            amount, 
            month: monthInt, 
            year: yearInt,
            a_used: 0, // Assuming you start with zero amount used
            a_left: amount  // Assuming a_left is equal to amount initially
        });
        await newBudget.save();

        const budgets = await Budget.find();
        var email = req.session.email;
        const monthlyIncomes = await Income.find();
        const fInsTotals = await getFInsTotals(email);
        let enhancedIncomes = await enhanceIncomesWithRelatedBudgets(monthlyIncomes, budgets);

        const transactions = await Transaction.find({ username: email }).sort({ date: -1 }).lean().exec();

        res.render('budget', { 
            budgets, 
            email, 
            transactions,
            monthlyIncomes: enhancedIncomes,
            fInsTotals,
            activeTab: 'budget-planning'
        });
    } catch (error) {
        console.error("Error adding new budget: ", error);
        res.status(500).send("Error adding budget");
    }
});



// Delete a budget
app.post('/delete-budget', async (req, res) => {
    const budgetId = req.body.budget_id;
    var email = req.session.email;

    try {
        if (!budgetId || !mongoose.Types.ObjectId.isValid(budgetId)) {
            return res.status(400).send('Invalid budget ID');
        }

        const budget = await Budget.findOne({ _id: budgetId, username: email });
        if (!budget) {
            return res.status(404).send('Budget not found or access denied');
        }

        // Delete all transactions associated with this budget type
        await Transaction.deleteMany({ category: budget.type, username: email });

        // Delete the budget
        await Budget.findByIdAndDelete(budgetId);

        // Update the incomes after budget and transaction changes
        await updateIncomeWithBudgetUsage();

        // Fetch updated data
        const budgets = await Budget.find({ username: email });
        const transactions = await Transaction.find({ username: email }).sort({ date: -1 }).lean().exec();
        const monthlyIncomes = await Income.find({ username: email });
        const fInsTotals = await getFInsTotals(email);
        let enhancedIncomes = await enhanceIncomesWithRelatedBudgets(monthlyIncomes, budgets);

        // Redirect to the budget page with updated list
        res.render('budget', {
            budgets,
            email: email,
            transactions,
            monthlyIncomes: enhancedIncomes,
            fInsTotals,
            activeTab: 'budget-planning'
        });
    } catch (error) {
        console.error('Error deleting budget:', error);
        res.status(500).send('Error deleting budget');
    }
});



async function updateBudgetOnTransaction(category, transactionPrice, transactionDate) {
    try {
        // Convert transactionPrice to a number
        const price = parseFloat(transactionPrice);

        // Extract month and year from transactionDate
        const transactionMonth = transactionDate.getMonth() + 1; // getMonth() returns 0-11
        const transactionYear = transactionDate.getFullYear();

        // Find the budget with the matching type, month, and year
        let budget = await Budget.findOne({
            type: category,
            month: transactionMonth,
            year: transactionYear
        });

        if (budget) {
            // Ensure budget fields are treated as numbers
            const currentUsed = parseFloat(budget.a_used);
            const currentAmount = parseFloat(budget.amount);

            // Update the a_used field
            budget.a_used = currentUsed + price;
            budget.a_left = currentAmount - budget.a_used; // Recalculate a_left

            await budget.save();
        }
    } catch (error) {
        console.error("Error updating budget on transaction: ", error);
        throw error; // Rethrow the error to handle it in the calling function
    }
}

app.post('/add-income', async (req, res) => {
    const { amount, month, year } = req.body;
    var email = req.session.email; // Get the email of the logged-in user

    try {
        // Check if an income already exists for the given month and year
        const existingIncome = await Income.findOne({ 
            username: email, 
            month: month, 
            year: year 
        });

        if (existingIncome) {
            // If income already exists, send a message instead of saving new income
            console.log("Income already exists for this month and year.");
            return res.status(400).send("Income already exists for this month and year.");
        }

        // Create new income since it doesn't exist
        const newIncome = new Income({ 
            username: email, // Include the username
            amount, 
            month, 
            year, 
            a_left: amount // Assuming a_left is equal to amount initially
        });

        await newIncome.save();

        // Fetch updated data
        const budgets = await Budget.find({ username: email });
        const monthlyIncomes = await Income.find({ username: email }); 
        const transactionDocs = await Transaction.find({ username: email }).sort({ date: -1 }).lean().exec();
        const fInsTotals = await getFInsTotals(email);

        // Render the page with updated data
        res.render('budget', { 
            budgets, 
            email, 
            transactions: transactionDocs,
            monthlyIncomes,
            fInsTotals,
            activeTab: 'goal-tracking' 
        });

    } catch (error) {
        console.error("Error saving income data: ", error);
        res.status(500).send("Error saving income data");
    }
});

app.post('/delete-income', async (req, res) => {
    try {
        const incomeId = req.body.income_id;
        if (!incomeId || !mongoose.Types.ObjectId.isValid(incomeId)) {
            return res.status(400).send('Invalid income ID');
        }

        // Delete the income entry
        await Income.findByIdAndDelete(incomeId);

        // Optional: Update related data if needed
        // e.g., update budgets or other related data

        // Redirect or render the page again
        // Fetch updated data
        const budgets = await Budget.find();
        const monthlyIncomes = await Income.find();
        const transactions = await Transaction.find({ username: req.session.email }).sort({ date: -1 }).lean().exec();

        res.render('budget', {
            budgets,
            email: req.session.email,
            transactions,
            monthlyIncomes,
            activeTab: 'goal-tracking' // Update as needed
        });
    } catch (error) {
        console.error('Error deleting income:', error);
        res.status(500).send('Error deleting income');
    }
});

async function updateIncomeWithBudgetUsage() {
    try {
        // Recalculate the total amount used from all budgets
        const totalUsedFromBudgets = (await Budget.find()).reduce((sum, budget) => sum + budget.a_used, 0);

        // Fetch all income records
        const incomes = await Income.find();

        // Update each income record based on the new total used amount
        for (let income of incomes) {
            income.a_used = totalUsedFromBudgets;
            income.a_left = income.amount - totalUsedFromBudgets;
            await income.save();
        }
    } catch (error) {
        console.error("Error updating income with budget usage: ", error);
        throw error;
    }
}


async function enhanceIncomesWithRelatedBudgets(incomes, budgets) {
    return await Promise.all(incomes.map(async (income) => {
        let relatedBudgets = budgets.filter(budget => 
            budget.month === income.month && budget.year === income.year
        );
        return { ...income.toObject(), relatedBudgets: relatedBudgets };
    }));
}

app.get("/logout", function(req, res) {
    req.logout(function(err) {
        if (err) { 
            console.log(err);
        }
        res.redirect("/");
    });
});
