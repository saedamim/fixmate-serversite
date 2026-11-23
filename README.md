# FixMate — Backend API

FixMate Backend is a RESTful API built with Node.js and Express.js. It manages authentication, users, repair services, bookings, role-based authorization, image uploads, and Stripe payments.

**Live API:** https://fixmate-client-vs29.vercel.app

**Frontend:** https://fixmate-client-chi-ten.vercel.app

## Features

### 1. Authentication and Authorization
- Better Auth integration.
- Email and password authentication.
- Google OAuth authentication.
- JWT-based authentication for protected API routes.
- Role-based authorization for Customer, Technician, and Admin.
- Secure token verification.
- Ownership-based access control.

### 2. User Management
- Manage registered users.
- Support Customer, Technician, and Admin roles.
- Update user profile information.
- Manage user roles through admin access.

### 3. Service Management
- Create repair service listings.
- Update and delete owned services.
- Upload service images through ImgBB.
- Admin service approval system.
- Manage service availability.
- Public service listing API.
- Server-side search, filtering, sorting, and pagination.
- Featured services.

### 4. Booking Management
- Customers can create repair requests.
- Prevent duplicate active bookings for the same service.
- Customers can view their own bookings.
- Customers can cancel eligible requested bookings.
- Technicians can view their assigned requests.
- Technicians can accept or reject requests.
- Technicians can update repair progress.
- Technicians can complete repair jobs.
- Booking ownership and status transition validation.

### 5. Payment Management
- Stripe Test Mode integration.
- Stripe Checkout Session creation.
- Payment allowed only for completed and unpaid bookings.
- Server-side payment amount validation.
- Stripe payment verification.
- Stripe webhook handling.
- Duplicate payment protection through idempotent processing.
- Payment transaction history.

### 6. Admin Management
- View platform statistics.
- Manage users and roles.
- Approve technician services.
- View all bookings.
- View payment transactions and revenue.

## How It Works

### Authentication Flow
1. A user signs up or signs in through the frontend.
2. Better Auth handles authentication.
3. The backend manages authentication sessions and JWT verification.
4. Protected API requests are validated through authentication middleware.
5. Role-based middleware restricts access to authorized resources.

### Service Workflow
1. A technician creates a repair service.
2. The service is submitted for admin approval.
3. The admin reviews the listing.
4. Approved services become publicly available.
5. Customers can search, filter, sort, and view service details.

### Booking Workflow
1. A customer selects a repair service.
2. The customer submits a booking request with issue details.
3. The technician receives the request.
4. The technician accepts or rejects the request.
5. Accepted requests can move to in-progress.
6. After completing the repair, the technician marks the booking as completed.
7. The customer can then make payment.

### Payment Workflow
1. The customer opens a completed, unpaid booking.
2. The frontend requests a Stripe Checkout Session.
3. The backend verifies booking ownership and payment eligibility.
4. The backend calculates the payment amount using the booking's final amount.
5. The customer completes payment through Stripe Checkout.
6. Stripe sends payment events to the backend webhook.
7. The backend verifies and records the payment securely.

## Technologies Used

- Node.js
- Express.js
- MongoDB
- Better Auth
- JWT
- Stripe
- ImgBB
- JOSE

## API Overview

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/services` | Get services with search and filters |
| GET | `/api/services/featured` | Get featured services |
| GET | `/api/services/:id` | Get service details |
| POST | `/api/services` | Create a service |
| PATCH | `/api/services/:id` | Update a service |
| DELETE | `/api/services/:id` | Delete a service |
| GET | `/api/bookings/my` | Get customer bookings |
| POST | `/api/bookings` | Create a booking |
| PATCH | `/api/bookings/:id/cancel` | Cancel a booking |
| GET | `/api/bookings/technician` | Get technician bookings |
| PATCH | `/api/bookings/:id/status` | Update booking status |
| GET | `/api/admin/users` | Get users |
| PATCH | `/api/admin/users/:id/role` | Update user role |
| PATCH | `/api/admin/services/:id/approval` | Approve or reject a service |
| GET | `/api/admin/bookings` | Get all bookings |
| GET | `/api/admin/payments` | Get payment transactions |
| POST | `/api/payments/create-checkout-session` | Create Stripe Checkout Session |

## Database Collections

The application uses MongoDB for data storage.

- **users** — User account and profile information managed through Better Auth.
- **services** — Technician service listings.
- **bookings** — Customer repair requests and booking details.
- **payments** — Payment transaction records.

Better Auth may also create its own authentication-related collections, such as sessions, accounts, and verification records.

## Deployment

The backend is deployed on Vercel:

https://fixmate-client-vs29.vercel.app

## Frontend Repository

https://github.com/saedamim/fixmate-client
