import { Router } from 'express'
import { newTicketHandler } from '../controllers/newTicketController.ts'

export const newTicketRouter = Router()
newTicketRouter.post('/new-ticket', newTicketHandler)
