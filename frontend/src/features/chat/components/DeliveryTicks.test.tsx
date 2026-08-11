import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DeliveryTicks } from './DeliveryTicks.tsx'

describe('DeliveryTicks', () => {
  it('renders one tick labelled Sent for a delivered-to-server message', () => {
    render(<DeliveryTicks deliveryState="sent" />)
    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(document.querySelectorAll('svg')).toHaveLength(1)
  })

  it('renders two ticks labelled Seen once the other side has read it', () => {
    render(<DeliveryTicks deliveryState="read" />)
    expect(screen.getByText('Seen')).toBeInTheDocument()
    expect(document.querySelectorAll('svg')).toHaveLength(2)
  })

  it('treats the unused delivered state as sent rather than inventing a third look', () => {
    render(<DeliveryTicks deliveryState="delivered" />)
    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(document.querySelectorAll('svg')).toHaveLength(1)
  })

  it('renders nothing while sending, when failed, or when the state is unknown', () => {
    const { container: sending } = render(<DeliveryTicks deliveryState="sending" />)
    expect(sending).toBeEmptyDOMElement()
    const { container: failed } = render(<DeliveryTicks deliveryState="failed" />)
    expect(failed).toBeEmptyDOMElement()
    const { container: absent } = render(<DeliveryTicks />)
    expect(absent).toBeEmptyDOMElement()
  })

  it('colours only the read state, and lets the caller override that colour', () => {
    const { container } = render(<DeliveryTicks deliveryState="read" readClassName="text-sky-300" />)
    expect(container.querySelector('.text-sky-300')).not.toBeNull()
    expect(container.querySelector('.text-sky-500')).toBeNull()
  })

  it('hides the glyphs from assistive tech so the label is the only thing read out', () => {
    const { container } = render(<DeliveryTicks deliveryState="read" />)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
